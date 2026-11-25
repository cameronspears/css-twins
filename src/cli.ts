#!/usr/bin/env node
import { run, wantsColor } from './run.js';

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  color: wantsColor(process.env, !!process.stdout.isTTY),
});
