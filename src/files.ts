import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze, type Options, type Report } from './analyze.js';

/** Folders never worth scanning. Pass them by name to scan them anyway. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next']);

const toPosix = (path: string) => path.split(sep).join('/');

/**
 * Turns a glob into a regex that matches whole paths with forward slashes.
 * Supports `**`, `*`, `?` and `{a,b}`.
 *
 * @param glob - A pattern like `src/**\/*.css`.
 * @returns A regex to test relative paths against.
 */
export function globToRegExp(glob: string) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` matches any number of folders, including none.
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) source += '\\{';
      else {
        source += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const isGlob = (pattern: string) => /[*?{]/.test(pattern);

function walk(dir: string, found: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path, found);
    } else if (entry.name.endsWith('.css')) found.push(path);
  }
  return found;
}

/**
 * Finds the .css files (CSS modules included) that `patterns` name. Folders are searched
 * deeply, skipping node_modules, dist, build, out, coverage, .git and .next.
 *
 * @param patterns - Files, folders or globs relative to `cwd`. Empty means `cwd` itself.
 * @param cwd - The folder to resolve patterns from. Defaults to `process.cwd()`.
 * @returns Paths relative to `cwd`, sorted, with forward slashes.
 * @throws When a plain path (not a glob) doesn't exist.
 */
export function findCssFiles(patterns: string[], cwd = process.cwd()) {
  const found = new Set<string>();
  for (const pattern of patterns.length ? patterns : ['.']) {
    if (isGlob(pattern)) {
      const posix = toPosix(pattern).replace(/^\.\//, '');
      const parts = posix.split('/');
      const firstGlob = parts.findIndex(isGlob);
      const base = parts.slice(0, firstGlob).join('/') || '.';
      const matcher = globToRegExp(posix);
      if (!existsSync(join(cwd, base))) continue;
      for (const path of walk(join(cwd, base), [])) {
        const rel = toPosix(relative(cwd, path));
        if (matcher.test(rel)) found.add(rel);
      }
    } else {
      const full = join(cwd, pattern);
      if (!existsSync(full)) throw new Error(`Not found: ${pattern}`);
      if (statSync(full).isDirectory()) {
        for (const path of walk(full, [])) found.add(toPosix(relative(cwd, path)));
      } else found.add(toPosix(relative(cwd, full)));
    }
  }
  return [...found].sort();
}

/**
 * Finds the files `patterns` name, reads them and runs `analyze`. This is what the CLI does.
 *
 * @param patterns - Files, folders or globs, as for `findCssFiles`.
 * @param options - `analyze`'s options, plus `cwd` to resolve patterns from.
 * @returns The report, with file paths relative to `cwd`.
 *
 * @example
 * ```ts
 * import { analyzeFiles, formatReport } from 'css-twins';
 *
 * const report = analyzeFiles(['src', 'styles/main.css'], { scale: [120, 200, 350] });
 * if (report.scorecard.componentCopies > 0) console.log(formatReport(report));
 * ```
 */
export function analyzeFiles(
  patterns: string[],
  options: Options & { cwd?: string } = {}
): Report {
  const cwd = options.cwd ?? process.cwd();
  const sources = findCssFiles(patterns, cwd).map((file) => ({
    file,
    css: readFileSync(join(cwd, file), 'utf8'),
  }));
  return analyze(sources, options);
}
