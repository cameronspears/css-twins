import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compare, type Report } from './analyze.js';
import { loadConfig, toOptions, type Config } from './config.js';
import { analyzeFiles } from './files.js';
import { formatReport } from './format.js';

/** The text `css-twins --help` prints. */
export const HELP = `Usage: css-twins [paths or globs...] [options]

Finds near-copies in your CSS: animations that do the same thing, timings a few
ms apart, buttons and cards that are almost the same. Scans the current folder
when no path is given. Skips node_modules, dist, build and .git.

Options
  --json                Print the full report as JSON
  -t, --threshold <n>   How alike two things must be to count, 0 to 1 (default 0.8)
  --scale <ms,...>      The timings your system allows, like 120,200,350
  --shared <glob>       Files that hold your shared classes (repeatable)
  --fail-on <kinds>     Exit 1 if any are found: components, animations, timings, any
  --baseline <file>     Exit 1 if any count is worse than a saved --json report
  --config <file>       Read options from this file (default css-twins.config.json)
  --no-color            Plain output, even in a terminal
  -h, --help            Show this help
  -v, --version         Show the version

Examples
  npx css-twins                          Scan the current folder
  npx css-twins src "app/**/*.css"       Scan a folder and a glob
  npx css-twins --shared styles/kit.css  Point copies at your shared classes
  npx css-twins --json > twins.json      Save a report
  npx css-twins --baseline twins.json    In CI: fail when anything gets worse

Exit codes: 0 fine, 1 a --fail-on or --baseline check failed, 2 bad input.`;

const FAIL_KINDS = ['components', 'animations', 'timings', 'any'] as const;
type FailKind = (typeof FAIL_KINDS)[number];

/** Where `run` reads and writes. The CLI passes the real process; tests pass their own. */
export interface Io {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Whether to colour the report. */
  color: boolean;
}

class UsageError extends Error {}

/**
 * Decides whether to colour the output: `FORCE_COLOR` wins, then `NO_COLOR`, otherwise colour
 * only when writing to a terminal.
 *
 * @param env - The environment, usually `process.env`.
 * @param isTTY - Whether stdout is a terminal.
 * @returns True to colour.
 */
export function wantsColor(env: Record<string, string | undefined>, isTTY: boolean) {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return !env.NO_COLOR && isTTY;
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Which `--fail-on` kinds were found in the report, like "components: 2". */
function failures(report: Report, kinds: FailKind[]) {
  const found = {
    components: report.scorecard.componentCopies,
    animations: report.scorecard.animationCopies,
    timings: report.scorecard.strayTimings,
  };
  const wanted = kinds.includes('any') ? (['components', 'animations', 'timings'] as const) : kinds;
  return wanted.flatMap((kind) =>
    kind !== 'any' && found[kind] > 0 ? [`${kind}: ${found[kind]}`] : []
  );
}

function execute(args: string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        threshold: { type: 'string', short: 't' },
        scale: { type: 'string' },
        shared: { type: 'string', multiple: true },
        'fail-on': { type: 'string' },
        baseline: { type: 'string' },
        config: { type: 'string' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message.split('. ')[0]}. Run css-twins --help for the options.`);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (values.version) {
    io.out(readVersion());
    return 0;
  }

  const config: Config = loadConfig(io.cwd, values.config);
  if (values.threshold !== undefined) {
    const threshold = Number(values.threshold);
    if (!(threshold > 0 && threshold <= 1)) {
      throw new UsageError(`--threshold must be between 0 and 1, not "${values.threshold}".`);
    }
    config.threshold = threshold;
  }
  if (values.scale !== undefined) {
    const scale = values.scale.split(',').map((step) => Number.parseFloat(step));
    if (scale.some(Number.isNaN)) {
      throw new UsageError(`--scale must be numbers in ms, like 120,200,350.`);
    }
    config.scale = scale;
  }
  if (values.shared) config.shared = values.shared;
  const failOn = (values['fail-on']?.split(',') ?? []).map((kind) => kind.trim());
  const unknown = failOn.filter((kind) => !(FAIL_KINDS as readonly string[]).includes(kind));
  if (unknown.length) {
    throw new UsageError(`--fail-on takes ${FAIL_KINDS.join(', ')}, not "${unknown.join(', ')}".`);
  }

  const report = analyzeFiles(positionals, { ...toOptions(config), cwd: io.cwd });
  if (!report.scorecard.files) {
    throw new UsageError(`No .css files found in ${positionals.join(', ') || 'this folder'}.`);
  }

  if (values.json) io.out(JSON.stringify(report, null, 2));
  else {
    io.out(
      formatReport(report, {
        scale: !!config.scale?.length,
        color: io.color && !values['no-color'],
      })
    );
  }

  let code = 0;
  const found = failures(report, failOn as FailKind[]);
  if (found.length) {
    io.err(`\nFound twins (--fail-on ${failOn.join(',')}):\n  ${found.join('\n  ')}`);
    code = 1;
  }
  if (values.baseline) {
    const before = JSON.parse(readFileSync(resolve(io.cwd, values.baseline), 'utf8')) as Report;
    const worse = compare(before.scorecard, report.scorecard);
    if (worse.length) {
      io.err(`\nWorse than ${values.baseline}:\n  ${worse.join('\n  ')}`);
      code = 1;
    } else if (!values.json) io.out(`\nNo worse than ${values.baseline}.`);
  }
  return code;
}

/**
 * Runs the CLI with `args` (without `node` and the script name) and returns the exit code:
 * 0 when all is fine, 1 when a `--fail-on` or `--baseline` check fails, 2 for bad input.
 *
 * @param args - The command-line arguments, like `['src', '--json']`.
 * @param io - Where to read files from and write output to.
 * @returns The exit code.
 */
export function run(args: string[], io: Io): number {
  try {
    return execute(args, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`css-twins: ${message}`);
    return 2;
  }
}
