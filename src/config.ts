import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Family, Options } from './analyze.js';
import { globToRegExp } from './files.js';

/** What `css-twins.config.json` can hold. Every field is optional. */
export interface Config {
  /** How alike two things must be to count as copies, 0 to 1. Default 0.8. */
  threshold?: number;
  /** The timings your system allows, in ms. */
  scale?: number[];
  /** Files or globs that hold your shared classes, like "styles/base.css". */
  shared?: string[];
  /** The component kinds to compare. Replaces the defaults. Patterns are regex strings. */
  families?: Family[];
}

/** The config file the CLI reads from the current folder when there is one. */
export const CONFIG_FILE = 'css-twins.config.json';

/**
 * Reads a config file.
 *
 * @param cwd - The folder to look in.
 * @param path - A config file to read. Without it, reads `css-twins.config.json` if present.
 * @returns The config, or `{}` when there is no default file.
 * @throws When `path` is given and doesn't exist, or the file isn't valid JSON.
 */
export function loadConfig(cwd: string, path?: string): Config {
  const file = resolve(cwd, path ?? CONFIG_FILE);
  if (!existsSync(file)) {
    if (path) throw new Error(`Config not found: ${path}`);
    return {};
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Config;
}

/**
 * Turns a config into options for `analyze`, making `shared` globs into an `isShared` test.
 *
 * @param config - What `loadConfig` returned.
 * @returns Options for `analyze` or `analyzeFiles`.
 */
export function toOptions(config: Config): Options {
  const shared = config.shared?.map((pattern) => globToRegExp(pattern.replace(/^\.\//, '')));
  return {
    ...(config.threshold !== undefined ? { threshold: config.threshold } : {}),
    ...(config.scale ? { scale: config.scale } : {}),
    ...(config.families ? { families: config.families } : {}),
    ...(shared?.length
      ? { isShared: (file: string) => shared.some((pattern) => pattern.test(file)) }
      : {}),
  };
}
