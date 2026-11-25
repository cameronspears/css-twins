import postcss, { type AtRule, type Container, type Declaration, type Root, type Rule } from 'postcss';

/**
 * Finds near-copies in a set of stylesheets: animations that do the same thing, timings a few
 * milliseconds apart and buttons or cards that are almost the same. Pure: it takes the CSS text,
 * so it never touches the disk.
 */

/** One class or animation in a group: where it lives and its name (without the dot). */
export interface Member {
  file: string;
  name: string;
}

/** A group of near-copies, such as three buttons that look almost the same. */
export interface Cluster {
  family: string;
  /** How alike the members are, 0 to 1, against the first member. */
  similarity: number;
  members: Member[];
  /** The shared class closest to this group, if one is close enough to replace it. */
  use?: { file: string; name: string; similarity: number };
  /** What the first member sets, for reading the report. */
  sample: Record<string, string>;
}

/** A value and how many times it is used, like `{ value: '200ms', count: 12 }`. */
export interface ValueCount {
  value: string;
  count: number;
}

/** The headline counts. Every one but `files` and `animations` is better when lower. */
export interface Scorecard {
  /** Stylesheets scanned. */
  files: number;
  /** `@keyframes` found. */
  animations: number;
  /** Animations that could be dropped for another one: each group's size minus one. */
  animationCopies: number;
  /** Different durations used in transitions and animations. */
  timings: number;
  /** Uses of a duration that's off your scale, or used only once when there's no scale. */
  strayTimings: number;
  /** Different easing curves used. */
  easings: number;
  /** Different `:active` transforms. */
  pressEffects: number;
  /** Different `:focus-visible` outlines. */
  focusRings: number;
  /** Component classes that could be dropped for another one: each group's size minus one. */
  componentCopies: number;
}

/** Everything `analyze` finds. Groups are ranked biggest first and capped at 40 per list. */
export interface Report {
  scorecard: Scorecard;
  timing: {
    durations: ValueCount[];
    /** Off the scale when one is given, otherwise used only once. Loops of 1s or more are left out. */
    stray: ValueCount[];
    easings: ValueCount[];
    similarEasings: Array<{ a: string; b: string; distance: number }>;
  };
  states: { press: ValueCount[]; focus: ValueCount[]; disabled: ValueCount[] };
  animations: Cluster[];
  components: Cluster[];
}

/** A kind of component to compare, such as buttons or cards. */
export interface Family {
  /** The name shown in the report, like "Button". */
  family: string;
  /** Class names that belong to this family. A string is read as a case-insensitive regex. */
  name: RegExp | string;
  /** A rule must set at least one of these to count. */
  needs: string[];
  /** Which classes in the shared files can stand in for this family. Defaults to `name`. */
  shared?: RegExp | string;
  /** How alike two rules must be to group, 0 to 1. */
  threshold?: number;
}

/** Settings for `analyze` and `analyzeFiles`. All are optional. */
export interface Options {
  /** How alike two things must be to count as copies, 0 to 1. Default 0.8. Wins over each family's own. */
  threshold?: number;
  /** The timings your system allows, in ms. Without it, timings used only once are flagged. */
  scale?: number[];
  /**
   * Which files hold the shared classes the report should point to. Gets each file's path.
   * Defaults to files that declare custom properties on `:root`.
   */
  isShared?: (file: string) => boolean;
  /** The kinds of component to compare. Defaults to `DEFAULT_FAMILIES`. */
  families?: Family[];
}

/** One stylesheet to analyze: a name for the report and its CSS text. */
export interface Source {
  file: string;
  css: string;
}

const DEFAULT_THRESHOLD = 0.8;
const CLOSE_TO_SHARED = 0.7;
const MAX_CLUSTERS = 40;

/** The component kinds compared out of the box, matched by class name. */
export const DEFAULT_FAMILIES: Family[] = [
  // Buttons differ in padding and size more than other parts, so they group a little looser.
  {
    family: 'Button',
    name: /(button|btn|cta)/i,
    needs: ['height', 'padding-inline', 'background'],
    threshold: 0.65,
  },
  { family: 'Card', name: /(card|panel|tile|surface)/i, needs: ['border-radius', 'background'] },
  { family: 'Heading', name: /(title|heading|hero|headline)/i, needs: ['font-size'] },
  { family: 'Figure', name: /(stat|figure|metric|value|amount)/i, needs: ['font-size'] },
  { family: 'Input', name: /(input|field|search)/i, needs: ['background', 'border-radius'] },
  { family: 'Chip', name: /(chip|badge|tag|pill)/i, needs: ['font-size', 'border-radius'] },
  { family: 'Menu', name: /(menu|popover|dropdown|sheet|toast)/i, needs: ['border-radius'] },
  { family: 'Empty state', name: /(empty|nothing)/i, needs: ['font-size'] },
  { family: 'Label', name: /(label|eyebrow|caption|note|hint)/i, needs: ['font-size', 'color'] },
];

const VISUAL = new Set([
  'height',
  'padding-block',
  'padding-inline',
  'background',
  'color',
  'font-size',
  'font-weight',
  'letter-spacing',
  'line-height',
  'border',
  'border-radius',
  'box-shadow',
  'gap',
]);

const toRegExp = (pattern: RegExp | string) =>
  typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

const clean = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** Splits on a separator that isn't inside brackets. */
function splitTop(value: string, separator: ',' | ' ') {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** True outside media queries, supports and the like. `@layer` doesn't count. */
function isBaseContext(node: Rule | AtRule) {
  for (let parent = node.parent as Container | undefined; parent; ) {
    if (parent.type === 'atrule' && (parent as AtRule).name !== 'layer') return false;
    parent = parent.parent as Container | undefined;
  }
  return true;
}

function declarations(rule: Rule) {
  const found: Record<string, string> = {};
  rule.each((node) => {
    if (node.type !== 'decl') return;
    const decl = node as Declaration;
    const value = clean(decl.value);
    if (decl.prop === 'padding') {
      const [block = value, inline = block] = splitTop(value, ' ');
      found['padding-block'] = block;
      found['padding-inline'] = inline;
    } else if (decl.prop === 'min-height') found.height = value;
    else if (decl.prop === 'background-color') found.background = value;
    else found[decl.prop] = value;
  });
  return found;
}

const declaresTokens = (root: Root) => {
  let found = false;
  root.walkRules(':root', (rule) => {
    rule.walkDecls(/^--/, () => {
      found = true;
    });
  });
  return found;
};

/** Reads `--name: 14px` style tokens, so a literal and its token count as the same value. */
function readTokens(roots: Root[]) {
  const tokens: Record<string, string> = {};
  for (const root of roots) {
    root.walkRules(':root', (rule) => {
      if (!isBaseContext(rule)) return;
      rule.walkDecls(/^--/, (decl) => {
        // Custom properties keep their spaces, so trim before reading.
        const value = decl.value.trim();
        if (/^([\d.]+(px|ms|s|rem|em)|var\(--[\w-]+\))$/.test(value) && !(decl.prop in tokens)) {
          tokens[decl.prop] = value;
        }
      });
    });
  }
  // A token can point at another token, so follow each one to its value.
  for (const name of Object.keys(tokens)) {
    for (let hops = 0; hops < 5; hops += 1) {
      const next = tokens[name]?.match(/^var\((--[\w-]+)\)$/)?.[1];
      if (!next || !tokens[next]) break;
      tokens[name] = tokens[next];
    }
  }
  return tokens;
}

const resolver = (tokens: Record<string, string>) => (value: string) =>
  value.replace(/var\((--[\w-]+)\)/g, (match, name: string) => tokens[name] ?? match);

/**
 * Scores how alike two CSS values are.
 *
 * @param a - A cleaned CSS value, like `0 1px 3px`.
 * @param b - Another cleaned CSS value.
 * @returns 1 for the same value, 0.85 for the same shape with numbers a little apart, else 0.
 */
export function valueSimilarity(a: string, b: string) {
  if (a === b) return 1;
  const numbers = (text: string) => text.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  const shape = (text: string) => text.replace(/-?\d*\.?\d+/g, '#');
  if (shape(a) !== shape(b)) return 0;
  const [left, right] = [numbers(a), numbers(b)];
  if (!left.length || left.length !== right.length) return 0;
  const close = left.every((value, index) => {
    const other = right[index] ?? 0;
    const largest = Math.max(Math.abs(value), Math.abs(other));
    const diff = Math.abs(value - other);
    // Opacity, scale and line height live under 2, where a gap of 1 is a different look.
    if (largest < 2) return diff <= 0.06;
    return diff <= 2 || diff / largest <= 0.15;
  });
  return close ? 0.85 : 0;
}

/** How much of a shared class this rule already matches, for rules that do a bit more. */
function containment(rule: Record<string, string>, shared: Record<string, string>) {
  const keys = Object.keys(shared);
  if (keys.length < 2) return 0;
  return (
    keys.reduce(
      (sum, key) => sum + (key in rule ? valueSimilarity(rule[key]!, shared[key]!) : 0),
      0
    ) / keys.length
  );
}

/**
 * Scores how alike two sets of declarations are: the average `valueSimilarity` over every
 * property either side sets, so a property only one side has counts as a miss.
 *
 * @param a - Declarations as `{ property: value }`.
 * @param b - Declarations as `{ property: value }`.
 * @returns A score from 0 to 1.
 */
export function similarity(a: Record<string, string>, b: Record<string, string>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) return 0;
  let total = 0;
  for (const key of keys) {
    if (key in a && key in b) total += valueSimilarity(a[key]!, b[key]!);
  }
  return total / keys.size;
}

/** Takes the item with the most lookalikes and its lookalikes as a group, then repeats. */
function group<T>(items: T[], score: (a: T, b: T) => number, threshold: number) {
  const left = new Set(items.map((_, index) => index));
  const neighbours = items.map((item, index) =>
    items.flatMap((other, otherIndex) =>
      otherIndex !== index && score(item, other) >= threshold ? [otherIndex] : []
    )
  );
  const groups: Array<{ members: T[]; similarity: number }> = [];
  for (;;) {
    let best = -1;
    let count = 0;
    for (const index of left) {
      const size = neighbours[index]!.filter((other) => left.has(other)).length;
      if (size > count) [best, count] = [index, size];
    }
    if (best < 0) return groups;
    const others = neighbours[best]!.filter((other) => left.has(other));
    const scores = others.map((other) => score(items[best]!, items[other]!));
    groups.push({
      members: [best, ...others].map((index) => items[index]!),
      similarity: scores.reduce((sum, value) => sum + value, 0) / scores.length,
    });
    [best, ...others].forEach((index) => left.delete(index));
  }
}

const round = (value: number) => Math.round(value * 100) / 100;

const rank = (clusters: Cluster[]) =>
  clusters
    .sort((a, b) => b.members.length * b.similarity - a.members.length * a.similarity)
    .slice(0, MAX_CLUSTERS);

function count(values: string[]): ValueCount[] {
  const totals = new Map<string, number>();
  values.forEach((value) => totals.set(value, (totals.get(value) ?? 0) + 1));
  return [...totals]
    .map(([value, total]) => ({ value, count: total }))
    .sort((a, b) => b.count - a.count);
}

function keyframeSteps(rule: AtRule) {
  const steps: Record<string, string> = {};
  rule.each((node) => {
    if (node.type !== 'rule') return;
    for (const raw of (node as Rule).selector.split(',')) {
      const offset = clean(raw).replace('from', '0%').replace('to', '100%');
      (node as Rule).walkDecls((decl) => {
        steps[`${offset} ${decl.prop}`] = clean(decl.value);
      });
    }
  });
  return steps;
}

const toMs = (value: string) =>
  value.endsWith('ms') ? Number.parseFloat(value) : round(Number.parseFloat(value) * 1000);

const EASING_VALUE = /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(.*\)|linear\(.*\)|steps\(.*\))$/;

const NAMED_EASINGS: Record<string, string> = {
  ease: 'cubic-bezier(0.25,0.1,0.25,1)',
  'ease-in': 'cubic-bezier(0.42,0,1,1)',
  'ease-out': 'cubic-bezier(0,0,0.58,1)',
  'ease-in-out': 'cubic-bezier(0.42,0,0.58,1)',
};

function bezierOf(easing: string, easingTokens: Record<string, string>) {
  const token = easing.match(/^var\((--[\w-]+)\)$/)?.[1];
  const text = NAMED_EASINGS[easing] ?? (token ? easingTokens[token] : easing) ?? '';
  const match = text.match(/cubic-bezier\(([^)]+)\)/);
  return match ? match[1]!.split(',').map(Number) : null;
}

/**
 * Reads every stylesheet and groups the near-copies: animations that do the same thing,
 * component classes that look almost the same, and timings, easings and states that drift.
 * It works on CSS text only, so it never touches the disk.
 *
 * @param sources - The stylesheets, each with a file name for the report and its CSS.
 * @param options - Threshold, timing scale, shared files and component families.
 * @returns The report: a scorecard, the groups and the value counts.
 *
 * @example
 * ```ts
 * import { analyze } from 'css-twins';
 *
 * const report = analyze([
 *   { file: 'a.css', css: '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }' },
 *   { file: 'b.css', css: '@keyframes appear { 0% { opacity: 0 } 100% { opacity: 1 } }' },
 * ]);
 * report.scorecard.animationCopies; // 1
 * report.animations[0].members; // [{ file: 'a.css', name: 'fade' }, { file: 'b.css', name: 'appear' }]
 * ```
 */
export function analyze(sources: Source[], options: Options = {}): Report {
  const parsed = sources.map(({ file, css }) => ({ file, root: postcss.parse(css, { from: file }) }));
  const tokens = readTokens(parsed.map((entry) => entry.root));
  const easingTokens: Record<string, string> = {};
  parsed.forEach(({ root }) =>
    root.walkDecls(/^--/, (decl) => {
      const value = clean(decl.value);
      if (EASING_VALUE.test(value) && !(decl.prop in easingTokens)) easingTokens[decl.prop] = value;
    })
  );
  const resolve = resolver(tokens);
  const isEasing = (word: string) => {
    const token = word.match(/^var\((--[\w-]+)\)$/)?.[1];
    return token ? token in easingTokens : EASING_VALUE.test(word);
  };
  const sharedFiles = new Set(
    parsed
      .filter(({ file, root }) => (options.isShared ? options.isShared(file) : declaresTokens(root)))
      .map(({ file }) => file)
  );

  const durations: string[] = [];
  const easings: string[] = [];
  const keyframes: Array<Member & { steps: Record<string, string> }> = [];
  const rules: Array<Member & { decls: Record<string, string> }> = [];
  const press: string[] = [];
  const focus: string[] = [];
  const disabled: string[] = [];

  for (const { file, root } of parsed) {
    root.walkAtRules(/keyframes$/, (rule) => {
      keyframes.push({ file, name: rule.params, steps: keyframeSteps(rule) });
    });
    root.walkDecls(/^(transition|animation)(-duration|-timing-function)?$/, (decl) => {
      for (const part of splitTop(clean(decl.value), ',')) {
        if (/\binfinite\b/.test(part)) continue;
        let timed = false;
        for (const word of splitTop(part, ' ')) {
          const resolved = resolve(word);
          if (/^[\d.]+m?s$/.test(resolved)) {
            // The first time in a part is its duration; a second is a delay, which is free.
            if (!timed && toMs(resolved) > 0) durations.push(`${toMs(resolved)}ms`);
            timed = true;
          } else if (isEasing(word)) easings.push(word);
        }
      }
    });
    root.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes$/.test((rule.parent as AtRule).name)) return;
      const decls = declarations(rule);
      if (/:active/.test(rule.selector) && decls.transform) press.push(decls.transform);
      if (/:focus-visible/.test(rule.selector) && decls.outline) focus.push(decls.outline);
      if (/(:disabled|aria-disabled)/.test(rule.selector) && decls.opacity) {
        disabled.push(decls.opacity);
      }
      if (!isBaseContext(rule)) return;
      for (const selector of rule.selector.split(',')) {
        const match = selector.trim().match(/^\.([\w-]+)$/);
        if (!match) continue;
        const visual = Object.fromEntries(
          Object.entries(decls)
            .filter(([prop]) => VISUAL.has(prop))
            .map(([prop, value]) => [prop, resolve(value)])
        );
        if (!Object.keys(visual).length) continue;
        const earlier = rules.find((entry) => entry.file === file && entry.name === match[1]);
        if (earlier) Object.assign(earlier.decls, visual);
        else rules.push({ file, name: match[1]!, decls: visual });
      }
    });
  }

  const isShared = (rule: Member) => sharedFiles.has(rule.file);

  const components = (options.families ?? DEFAULT_FAMILIES).flatMap((spec) => {
    const name = toRegExp(spec.name);
    const sharedName = toRegExp(spec.shared ?? spec.name);
    const candidates = rules.filter(
      (rule) =>
        name.test(rule.name) &&
        spec.needs.some((prop) => prop in rule.decls) &&
        Object.keys(rule.decls).length >= 3
    );
    const shared = rules.filter((rule) => isShared(rule) && sharedName.test(rule.name));
    return group(
      candidates.filter((rule) => !isShared(rule)),
      (a, b) => similarity(a.decls, b.decls),
      options.threshold ?? spec.threshold ?? DEFAULT_THRESHOLD
    ).map(({ members, similarity: alike }): Cluster => {
      const first = members[0]!;
      const best = shared
        .map((rule) => ({
          file: rule.file,
          name: rule.name,
          similarity: round(
            Math.max(similarity(first.decls, rule.decls), containment(first.decls, rule.decls) * 0.9)
          ),
        }))
        .sort((a, b) => b.similarity - a.similarity)[0];
      return {
        family: spec.family,
        similarity: round(alike),
        members: members.map(({ file, name: member }) => ({ file, name: member })),
        ...(best && best.similarity >= CLOSE_TO_SHARED ? { use: best } : {}),
        sample: first.decls,
      };
    });
  });

  const animations = group(
    keyframes,
    (a, b) => similarity(a.steps, b.steps),
    options.threshold ?? DEFAULT_THRESHOLD
  ).map(({ members, similarity: alike }) => ({
    family: 'Animation',
    similarity: round(alike),
    members: members.map(({ file, name }) => ({ file, name })),
    sample: members[0]!.steps,
  }));

  const durationCounts = count(durations);
  const scale = options.scale;
  const stray = durationCounts.filter(({ value, count: uses }) => {
    const ms = Number.parseFloat(value);
    if (ms >= 1000) return false;
    return scale?.length ? !scale.includes(ms) : uses === 1;
  });
  const easingCounts = count(easings);
  const similarEasings = easingCounts.flatMap(({ value: a }, index) =>
    easingCounts.slice(index + 1).flatMap(({ value: b }) => {
      const [left, right] = [bezierOf(a, easingTokens), bezierOf(b, easingTokens)];
      if (!left || !right) return [];
      const distance = Math.max(...left.map((value, i) => Math.abs(value - (right[i] ?? 0))));
      return distance <= 0.2 ? [{ a, b, distance: round(distance) }] : [];
    })
  );

  const extras = (clusters: Cluster[]) =>
    clusters.reduce((sum, cluster) => sum + cluster.members.length - 1, 0);

  return {
    scorecard: {
      files: sources.length,
      animations: keyframes.length,
      animationCopies: extras(animations),
      timings: durationCounts.length,
      strayTimings: stray.reduce((sum, { count: uses }) => sum + uses, 0),
      easings: easingCounts.length,
      pressEffects: new Set(press).size,
      focusRings: new Set(focus).size,
      componentCopies: extras(components),
    },
    timing: { durations: durationCounts, stray, easings: easingCounts, similarEasings },
    states: { press: count(press), focus: count(focus), disabled: count(disabled) },
    // The report keeps the biggest groups. The counts above cover every group.
    animations: rank(animations),
    components: rank(components),
  };
}

/** The scorecard counts where a higher number means more drift. */
export const LOWER_IS_BETTER = [
  'animationCopies',
  'timings',
  'strayTimings',
  'easings',
  'pressEffects',
  'focusRings',
  'componentCopies',
] as const satisfies ReadonlyArray<keyof Scorecard>;

/**
 * Compares two scorecards, for failing CI when the CSS drifts.
 *
 * @param before - The scorecard from a saved report.
 * @param now - The scorecard from a fresh run.
 * @returns Each count that got worse, like `"componentCopies: 4 (was 2)"`. Empty when none did.
 */
export function compare(before: Scorecard, now: Scorecard) {
  return LOWER_IS_BETTER.filter((name) => now[name] > (before[name] ?? 0)).map(
    (name) => `${name}: ${now[name]} (was ${before[name] ?? 0})`
  );
}
