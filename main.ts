// main.ts — the program the harness runs: `node /bot/main.ts` (Node 22).
// It reads every case from the input directory's cases.json, answers each one
// with run() from solve.js, and writes the answers to the output directory's
// answers.json. The solve module is found from this file's own location, so
// the program works from whatever directory the grader starts it in.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";

// V8's incremental marking off, set before solve.js is imported, so all of
// its work runs under it (the rules allow an entry to tune V8 this way).
setFlagsFromString("--no-incremental-marking");

const { run } = (await import(new URL("./solve.js", import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(INPUT_DIR, "cases.json"), "utf8")) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, "answers.json"), JSON.stringify(answers));
