import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { run, wantsColor } from '../src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'css-twins-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function cli(args: string[], { cwd = ROOT, color = false } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    cwd,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    color,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli', () => {
  it('prints the README example for the fixtures', () => {
    const { code, out } = cli(['fixtures']);
    expect(code).toBe(0);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const example = readme.match(/```text\n\$ npx css-twins fixtures\n([\s\S]*?)```/)?.[1];
    expect(example?.trimEnd()).toBe(out);
  });

  it('prints JSON with --json', () => {
    const { code, out } = cli(['fixtures', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).scorecard.componentCopies).toBe(2);
  });

  it('colours only when asked', () => {
    expect(cli(['fixtures']).out).not.toContain('\u001b[');
    expect(cli(['fixtures'], { color: true }).out).toContain('\u001b[');
    expect(cli(['fixtures', '--no-color'], { color: true }).out).not.toContain('\u001b[');
  });

  it('colours in a terminal unless NO_COLOR, and always with FORCE_COLOR', () => {
    expect(wantsColor({}, true)).toBe(true);
    expect(wantsColor({}, false)).toBe(false);
    expect(wantsColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(wantsColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(wantsColor({ FORCE_COLOR: '0' }, true)).toBe(true);
  });

  it('takes --threshold, --scale and --shared', () => {
    const loose = JSON.parse(cli(['fixtures', '--json', '-t', '0.5']).out);
    expect(loose.scorecard.animationCopies).toBeGreaterThan(2);
    const scaled = JSON.parse(cli(['fixtures', '--json', '--scale', '150,200,350']).out);
    expect(scaled.timing.stray).toEqual([{ value: '160ms', count: 1 }]);
    const shared = JSON.parse(
      cli(['fixtures', '--json', '--shared', 'fixtures/components/Toast.module.css']).out
    );
    expect(shared.components.some((group: { use?: unknown }) => group.use)).toBe(false);
    const both = JSON.parse(
      cli(['fixtures', '--json', '--shared', 'nothing.css', '--shared', 'fixtures/styles/*.css']).out
    );
    expect(both.components.every((group: { use?: unknown }) => group.use)).toBe(true);
  });

  it('reads css-twins.config.json', () => {
    writeFileSync(join(scratch, 'a.css'), '.a { transition: color 150ms, opacity 150ms }');
    writeFileSync(join(scratch, 'css-twins.config.json'), JSON.stringify({ scale: [200] }));
    const report = JSON.parse(cli(['--json'], { cwd: scratch }).out);
    expect(report.timing.stray).toEqual([{ value: '150ms', count: 2 }]);
  });

  it('scans the current folder when no path is given', () => {
    expect(cli(['--json'], { cwd: join(ROOT, 'fixtures') }).code).toBe(0);
  });

  it('exits 1 with --fail-on when twins are found', () => {
    expect(cli(['fixtures', '--fail-on', 'components']).code).toBe(1);
    expect(cli(['fixtures/styles', '--fail-on', 'components,animations']).code).toBe(0);
  });

  it('exits 1 with --baseline when a count gets worse', () => {
    const saved = join(scratch, 'baseline.json');
    writeFileSync(saved, cli(['fixtures', '--json']).out);
    expect(cli(['fixtures', '--baseline', saved]).code).toBe(0);
    const worse = cli(['fixtures', '--baseline', saved, '-t', '0.5']);
    expect(worse.code).toBe(1);
    expect(worse.err).toContain('animationCopies');
  });

  it('exits 2 with a clear message on bad input', () => {
    expect(cli(['--nope'])).toMatchObject({ code: 2, err: expect.stringContaining('--nope') });
    expect(cli(['missing'])).toMatchObject({ code: 2, err: 'css-twins: Not found: missing' });
    expect(cli(['fixtures', '-t', '3']).code).toBe(2);
    expect(cli(['fixtures', '--fail-on', 'bogus']).code).toBe(2);
    expect(cli(['src']).err).toContain('No .css files found');
  });

  it('shows help and version', () => {
    expect(cli(['--help']).out).toContain('Examples');
    expect(cli(['-v']).out).toBe('0.1.0');
  });
});
