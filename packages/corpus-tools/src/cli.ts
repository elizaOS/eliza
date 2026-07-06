#!/usr/bin/env bun
/**
 * Command-line boundary for corpus validation. The library returns structured
 * diagnostics; this file is the only place that prints and converts validation
 * failure into a process exit code.
 */
import { validateCorpusTarget } from "./validator.ts";

async function main(argv: string[]): Promise<number> {
  const [command, target = "data"] = argv;
  if (command !== "validate") {
    process.stderr.write("usage: corpus validate <file-or-dir>\n");
    return 2;
  }

  const result = await validateCorpusTarget(target);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // error-policy:J1 CLI boundary translates validation/runtime failure to stderr.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
