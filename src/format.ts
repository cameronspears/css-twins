import { styleText } from 'node:util';
import type { Cluster, Report, ValueCount } from './analyze.js';

type Style = Parameters<typeof styleText>[0];

export interface FormatOptions {
  /** Say "off your scale" rather than "used once" for stray timings. Default false. */
  scale?: boolean;
  /** The most groups to show per section. Default 10. */
  limit?: number;
  /** Colour the output with ANSI codes. Default false. */
  color?: boolean;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Pads every column but the last to the widest cell, so rows line up. */
function table(rows: string[][], indent = '  ') {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join('   ')
        .trimEnd()
  );
}

/**
 * Turns a report into the short, readable text the CLI prints: one section per kind of copy,
 * with aligned columns, then a summary.
 *
 * @param report - What `analyze` or `analyzeFiles` returned.
 * @param options - How to word and colour the text. See `FormatOptions`.
 * @returns The report as lines of text joined with `\n`.
 */
export function formatReport(report: Report, options: FormatOptions = {}) {
  const { scale = false, limit = 10, color = false } = options;
  const paint = (style: Style, text: string) =>
    color ? styleText(style, text, { validateStream: false }) : text;
  const heading = (title: string, note: string) => `${paint('bold', title)}  ${paint('dim', note)}`;
  const { scorecard: score, timing, states } = report;
  const lines: string[] = [];

  const section = (title: string, list: Cluster[]) => {
    if (!list.length) return;
    lines.push(heading(title, plural(list.length, 'group')));
    for (const cluster of list.slice(0, limit)) {
      const label = cluster.family === 'Animation' ? 'Animation' : cluster.family;
      lines.push(`  ${label}  ${paint('yellow', `${percent(cluster.similarity)} alike`)}`);
      const rows = cluster.members.map(({ file, name }) => [
        cluster.family === 'Animation' ? name : `.${name}`,
        file,
        '',
      ]);
      if (cluster.use) {
        rows.push([`→ use .${cluster.use.name}`, cluster.use.file, `${percent(cluster.use.similarity)} alike`]);
      }
      for (const [index, line] of table(rows, '    ').entries()) {
        lines.push(index === cluster.members.length ? paint('green', line) : line);
      }
    }
    if (list.length > limit) lines.push(paint('dim', `  …and ${list.length - limit} more. Use --json for all.`));
    lines.push('');
  };

  const counted = (values: ValueCount[], note?: (value: ValueCount) => string) =>
    table(values.map((entry) => [entry.value, `×${entry.count}`, note?.(entry) ?? '']));

  lines.push(heading('css-twins', `${plural(score.files, 'file')} scanned`), '');
  section('Components that are almost the same', report.components);
  section('Animations that do the same thing', report.animations);

  if (timing.durations.length) {
    const why = scale ? 'off your scale' : 'used once';
    const stray = new Set(timing.stray.map(({ value }) => value));
    lines.push(heading('Timings', `${score.timings} in use, ${timing.stray.length} ${why}`));
    lines.push(
      ...counted(timing.durations, ({ value }) => (stray.has(value) ? paint('yellow', why) : ''))
    );
    lines.push('');
  }

  if (timing.easings.length) {
    lines.push(heading('Easings', `${score.easings} in use`));
    lines.push(...counted(timing.easings));
    for (const { a, b, distance } of timing.similarEasings) {
      lines.push(paint('yellow', `  Nearly the same curve: ${a} and ${b} (${distance} apart)`));
    }
    lines.push('');
  }

  const looks = (
    [
      ['Press effects', states.press],
      ['Focus rings', states.focus],
      ['Disabled looks', states.disabled],
    ] as const
  ).filter(([, values]) => values.length > 1);
  if (looks.length) {
    lines.push(heading('States with more than one look', plural(looks.length, 'state')));
    for (const [name, values] of looks) {
      lines.push(`  ${name}`, ...counted(values).map((line) => `  ${line}`));
    }
    lines.push('');
  }

  const total = (value: number) => (value ? paint('yellow', String(value)) : paint('green', '0'));
  lines.push(paint('bold', 'Summary'));
  lines.push(
    ...table([
      ['Component copies', total(score.componentCopies)],
      ['Animation copies', total(score.animationCopies)],
      ['Stray timings', total(score.strayTimings)],
      ['Similar easings', total(timing.similarEasings.length)],
    ])
  );
  return lines.join('\n');
}
