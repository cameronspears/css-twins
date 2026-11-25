import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  analyzeFiles,
  compare,
  findCssFiles,
  formatReport,
  globToRegExp,
  toOptions,
  valueSimilarity,
} from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('..', import.meta.url));

const css = (files: Record<string, string>) =>
  Object.entries(files).map(([file, text]) => ({ file, css: text }));

const BUTTON = `height: 40px; padding: 0 16px; border-radius: 10px; background: #2563eb; color: #fff;`;

describe('values', () => {
  it('scores the same shape with close numbers as alike', () => {
    expect(valueSimilarity('0 1px 3px', '0 1px 3px')).toBe(1);
    expect(valueSimilarity('0 1px 3px', '0 1px 4px')).toBe(0.85);
    expect(valueSimilarity('16px', '32px')).toBe(0);
    expect(valueSimilarity('solid 1px', '1px solid')).toBe(0);
  });

  it('keeps small numbers like opacity strict', () => {
    expect(valueSimilarity('0.5', '0.53')).toBe(0.85);
    expect(valueSimilarity('0.5', '0.9')).toBe(0);
  });
});

describe('animations', () => {
  it('groups keyframes that do the same thing, however the steps are written', () => {
    const report = analyze(
      css({
        'a.css': `@keyframes fade { from { opacity: 0 } to { opacity: 1 } }`,
        'b.css': `@keyframes appear { 0% { opacity: 0 } 100% { opacity: 1 } }`,
        'c.css': `@keyframes spin { to { transform: rotate(360deg) } }`,
      })
    );
    expect(report.animations).toHaveLength(1);
    expect(report.animations[0]!.members.map((m) => m.name).sort()).toEqual(['appear', 'fade']);
    expect(report.scorecard).toMatchObject({ animations: 3, animationCopies: 1 });
  });
});

describe('the documented example', () => {
  it('works as the analyze JSDoc says', () => {
    const report = analyze([
      { file: 'a.css', css: '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }' },
      { file: 'b.css', css: '@keyframes appear { 0% { opacity: 0 } 100% { opacity: 1 } }' },
    ]);
    expect(report.scorecard.animationCopies).toBe(1);
    expect(report.animations[0]!.members).toEqual([
      { file: 'a.css', name: 'fade' },
      { file: 'b.css', name: 'appear' },
    ]);
  });
});

describe('timing', () => {
  it('counts durations through tokens, skips delays and loops', () => {
    const report = analyze(
      css({
        'a.css': `:root { --fast: 150ms }
          .a { transition: opacity var(--fast) ease, transform 0.15s ease 300ms; }
          .b { animation: spin 2s linear infinite; }
          .d { transition: opacity 1200ms; }
          .c { transition: color 210ms ease-out; }`,
      })
    );
    expect(report.timing.durations).toEqual([
      { value: '150ms', count: 2 },
      { value: '1200ms', count: 1 },
      { value: '210ms', count: 1 },
    ]);
    expect(report.timing.stray).toEqual([{ value: '210ms', count: 1 }]);
  });

  it('flags timings off the scale when one is given', () => {
    const report = analyze(css({ 'a.css': `.a { transition: color 150ms, opacity 150ms }` }), {
      scale: [120, 200],
    });
    expect(report.timing.stray).toEqual([{ value: '150ms', count: 2 }]);
    expect(report.scorecard.strayTimings).toBe(2);
  });

  it('finds easings that are nearly the same curve, through tokens', () => {
    const report = analyze(
      css({
        'a.css': `:root { --snap: cubic-bezier(0.2, 0.8, 0.2, 1) }
          .a { transition: color 150ms var(--snap) }
          .b { transition: color 150ms cubic-bezier(0.25, 0.8, 0.25, 1) }`,
      })
    );
    expect(report.timing.similarEasings).toEqual([
      { a: 'var(--snap)', b: 'cubic-bezier(0.25, 0.8, 0.25, 1)', distance: 0.05 },
    ]);
  });
});

describe('components', () => {
  it('groups near-copy buttons and points them at the shared one', () => {
    const report = analyze(
      css({
        'shared.css': `:root { --r: 10px } .btn { ${BUTTON.replace('10px', 'var(--r)')} }`,
        'a.module.css': `.buyButton { ${BUTTON} }`,
        'b.module.css': `.ctaButton { ${BUTTON.replace('16px', '18px')} }`,
      })
    );
    expect(report.components).toHaveLength(1);
    const [group] = report.components;
    expect(group!.family).toBe('Button');
    expect(group!.members.map((m) => m.file).sort()).toEqual(['a.module.css', 'b.module.css']);
    expect(group!.use).toMatchObject({ file: 'shared.css', name: 'btn' });
  });

  it('reads padding as block and inline, and min-height as height', () => {
    const report = analyze(
      css({
        'a.css': `.oneButton { min-height: 40px; padding-block: 0; padding-inline: 16px; border-radius: 10px; background: #2563eb; color: #fff }
          .twoButton { ${BUTTON} }`,
      })
    );
    expect(report.components[0]?.similarity).toBe(1);
  });

  it('suggests a smaller shared class that a rule fully contains', () => {
    const report = analyze(
      css({
        'kit.css': `:root { --x: 1px } .btn { height: 40px; background: #2563eb; color: #fff }`,
        'a.css': `.aButton { ${BUTTON} box-shadow: none; }
          .bButton { ${BUTTON} box-shadow: none; }`,
      })
    );
    expect(report.components[0]?.use?.name).toBe('btn');
  });

  it('compares only plain single-class selectors', () => {
    const report = analyze(
      css({
        'a.css': `.list > .oneButton { ${BUTTON} } button.twoButton { ${BUTTON} } .threeButton { ${BUTTON} }`,
      })
    );
    expect(report.components).toEqual([]);
  });

  it('leaves out rules inside media queries', () => {
    const report = analyze(
      css({
        'a.css': `.oneButton { ${BUTTON} } @media (min-width: 600px) { .twoButton { ${BUTTON} } }`,
      })
    );
    expect(report.components).toEqual([]);
  });

  it('respects the threshold and custom families', () => {
    const files = css({
      'a.css': `.x-box { padding: 20px; border-radius: 12px; background: #fff }
        .y-box { padding: 20px 26px; border-radius: 12px; background: #fff }`,
    });
    const families = [{ family: 'Box', name: '-box$', needs: ['background'] }];
    expect(analyze(files, { families }).components).toEqual([]);
    expect(analyze(files, { families, threshold: 0.7 }).components[0]?.family).toBe('Box');
  });

  it('takes shared files from the config', () => {
    const options = toOptions({ shared: ['kit/*.css'] });
    expect(options.isShared?.('kit/base.css')).toBe(true);
    expect(options.isShared?.('pages/home.css')).toBe(false);
  });
});

describe('baseline', () => {
  it('lists counts that got worse', () => {
    const before = analyze(css({ 'a.css': `.a { transition: color 150ms }` })).scorecard;
    const now = analyze(css({ 'a.css': `.a { transition: color 150ms, opacity 160ms }` })).scorecard;
    expect(compare(before, before)).toEqual([]);
    expect(compare(before, now)).toEqual(['timings: 2 (was 1)', 'strayTimings: 2 (was 1)']);
  });
});

describe('files', () => {
  it('matches globs', () => {
    expect(globToRegExp('src/**/*.css').test('src/a/b/c.css')).toBe(true);
    expect(globToRegExp('src/**/*.css').test('src/c.css')).toBe(true);
    expect(globToRegExp('*.{css,scss}').test('a.scss')).toBe(true);
    expect(globToRegExp('*.css').test('a/b.css')).toBe(false);
  });

  it('skips node_modules and build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'css-twins-'));
    try {
      for (const folder of ['src', 'node_modules/pkg', 'dist', '.git']) {
        mkdirSync(join(dir, folder), { recursive: true });
        writeFileSync(join(dir, folder, 'a.css'), '.a { color: red }');
      }
      expect(findCssFiles([], dir)).toEqual(['src/a.css']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds CSS files and modules in folders and globs', () => {
    expect(findCssFiles(['fixtures'], FIXTURES)).toEqual([
      'fixtures/components/Header.module.css',
      'fixtures/components/Pricing.module.css',
      'fixtures/components/Toast.module.css',
      'fixtures/styles/tokens.css',
    ]);
    expect(findCssFiles(['fixtures/**/*.module.css'], FIXTURES)).toHaveLength(3);
  });

  it('reports the fixtures the README shows', () => {
    const report = analyzeFiles(['fixtures'], { cwd: FIXTURES });
    expect(report.scorecard).toMatchObject({
      files: 4,
      animationCopies: 2,
      componentCopies: 2,
      strayTimings: 2,
      pressEffects: 2,
      focusRings: 2,
    });
    expect(formatReport(report)).toMatch(/→ use \.btn\s+fixtures\/styles\/tokens\.css/);
  });
});
