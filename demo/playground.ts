// The browser playground. It imports only the pure analyzer, which never touches the disk.
import { analyze, type Cluster, type Report, type Source, type ValueCount } from '../src/analyze.js';

const SAMPLE = `/* @file styles/tokens.css */
:root {
  --radius: 10px;
  --fast: 150ms;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
}

.btn {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--radius);
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  transition: background var(--fast) var(--ease-out);
}

.card {
  padding: 20px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* @file components/Header.module.css */
.ctaButton {
  height: 40px;
  padding: 0 18px;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  transition: background 160ms ease-out;
}

@keyframes appear {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

/* @file components/Pricing.module.css */
.planCard {
  padding: 20px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.1);
}

.featureCard {
  padding: 20px 22px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.1);
}

.buyButton {
  height: 40px;
  padding: 0 16px;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font-weight: 600;
  transition: background 150ms cubic-bezier(0.25, 0.8, 0.25, 1);
}
`;

const MARKER = /^\/\*\s*@file\s+(\S+)\s*\*\/\s*$/m;

/** Splits the editor text into files at each `/* @file name.css *\/` line. */
function toSources(text: string): Source[] {
  const parts = text.split(new RegExp(MARKER.source, 'gm'));
  // split() with a capture group gives [before, name, body, name, body, ...].
  const sources: Source[] = [];
  if (parts[0]!.trim()) sources.push({ file: 'input.css', css: parts[0]! });
  for (let i = 1; i < parts.length; i += 2) sources.push({ file: parts[i]!, css: parts[i + 1] ?? '' });
  return sources;
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

const percent = (value: number) => `${Math.round(value * 100)}%`;

const howMany = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function group(cluster: Cluster) {
  const dot = cluster.family === 'Animation' ? '' : '.';
  const members = cluster.members
    .map((member) => `<li><code>${dot}${escape(member.name)}</code> in ${escape(member.file)}</li>`)
    .join('');
  const use = cluster.use
    ? `<p>Use <code>.${escape(cluster.use.name)}</code> from ${escape(cluster.use.file)} (${percent(cluster.use.similarity)} alike).</p>`
    : '';
  return `<h3>${escape(cluster.family)}, ${percent(cluster.similarity)} alike</h3><ul>${members}</ul>${use}`;
}

const list = (values: ValueCount[], flagged = new Set<string>(), note = '') =>
  `<ul>${values
    .map(
      ({ value, count }) =>
        `<li><code>${escape(value)}</code> ×${count}${flagged.has(value) ? `, ${note}` : ''}</li>`
    )
    .join('')}</ul>`;

function render(report: Report) {
  const { scorecard: score, timing, states } = report;
  const summary = [
    howMany(score.componentCopies, 'component copy', 'component copies'),
    howMany(score.animationCopies, 'animation copy', 'animation copies'),
    howMany(score.strayTimings, 'stray timing', 'stray timings'),
    howMany(timing.similarEasings.length, 'similar easing', 'similar easings'),
  ];
  const sections = [`<p>${summary.slice(0, -1).join(', ')} and ${summary.at(-1)}.</p>`];
  if (report.components.length) {
    sections.push(`<h2>Components that are almost the same</h2>${report.components.map(group).join('')}`);
  }
  if (report.animations.length) {
    sections.push(`<h2>Animations that do the same thing</h2>${report.animations.map(group).join('')}`);
  }
  if (!report.components.length && !report.animations.length) {
    sections.push(`<p class="muted">No twins found. Try copying a rule and changing a value by a pixel.</p>`);
  }
  if (timing.durations.length) {
    const stray = new Set(timing.stray.map(({ value }) => value));
    sections.push(`<h2>Timings</h2>${list(timing.durations, stray, 'used once')}`);
  }
  if (timing.easings.length) {
    const similar = timing.similarEasings
      .map(({ a, b, distance }) => `<p>Nearly the same curve: <code>${escape(a)}</code> and <code>${escape(b)}</code> (${distance} apart).</p>`)
      .join('');
    sections.push(`<h2>Easings</h2>${list(timing.easings)}${similar}`);
  }
  for (const [name, values] of [
    ['Press effects', states.press],
    ['Focus rings', states.focus],
    ['Disabled looks', states.disabled],
  ] as const) {
    if (values.length > 1) sections.push(`<h2>${name}</h2>${list(values)}`);
  }
  return sections.join('');
}

const editor = document.getElementById('css') as HTMLTextAreaElement;
const output = document.getElementById('report') as HTMLElement;
const threshold = document.getElementById('threshold') as HTMLInputElement;
const thresholdValue = document.getElementById('threshold-value') as HTMLElement;
const reset = document.getElementById('reset') as HTMLButtonElement;

function update() {
  thresholdValue.textContent = percent(Number(threshold.value));
  const sources = toSources(editor.value);
  try {
    const report = analyze(sources, {
      threshold: Number(threshold.value),
      // One unsplit file can't be both the copies and the shared kit.
      ...(sources.length === 1 ? { isShared: () => false } : {}),
    });
    output.innerHTML = render(report);
  } catch (error) {
    output.innerHTML = `<p class="muted">Can't read that CSS yet: ${escape((error as Error).message)}</p>`;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(update, 200);
};

editor.value = SAMPLE;
editor.addEventListener('input', later);
threshold.addEventListener('input', update);
reset.addEventListener('click', () => {
  editor.value = SAMPLE;
  threshold.value = '0.8';
  update();
});
update();
