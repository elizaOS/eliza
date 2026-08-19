#!/usr/bin/env bun
/**
 * Command-line boundary for corpus validation and reviewed deletion. Library
 * operations return structured results; this file owns printing and process
 * exit codes.
 */
import {
  applyDeletionFiles,
  planDeletionFiles,
} from "./pipeline/delete-command.ts";
import { validateCorpusTarget } from "./validator.ts";

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function requireFlagValue(args: string[], flag: string): string {
  const value = readFlagValue(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command, maybeTarget = "data", ...rest] = argv;
  if (command === "validate") {
    const result = await validateCorpusTarget(maybeTarget);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (command === "delete") {
    if (maybeTarget === "plan") {
      const result = await planDeletionFiles({
        targetPath: requireFlagValue(rest, "--target"),
        candidatesPath: requireFlagValue(rest, "--candidates"),
        rulesPath: requireFlagValue(rest, "--rules"),
        queuePath: requireFlagValue(rest, "--queue"),
        normalizedRulesPath: requireFlagValue(rest, "--normalized-rules"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (maybeTarget === "apply") {
      const result = await applyDeletionFiles({
        targetPath: requireFlagValue(rest, "--target"),
        candidatesPath: requireFlagValue(rest, "--candidates"),
        normalizedRulesPath: requireFlagValue(rest, "--normalized-rules"),
        queuePath: requireFlagValue(rest, "--queue"),
        decisionsPath: requireFlagValue(rest, "--decisions"),
        outputPath: requireFlagValue(rest, "--output"),
        ledgerPath: requireFlagValue(rest, "--ledger"),
        manifestPath: requireFlagValue(rest, "--manifest"),
        approvalPath: requireFlagValue(rest, "--approval"),
        reportPath: requireFlagValue(rest, "--report"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    throw new Error("corpus delete requires plan or apply");
  }

  process.stderr.write(
    "usage: corpus validate <file-or-dir>\n       corpus delete plan --target <dir> --rules <file> --candidates <file> --queue <file> --normalized-rules <file>\n       corpus delete apply --target <dir> --candidates <file> --normalized-rules <file> --queue <file> --decisions <file> --output <dir> --ledger <file> --manifest <file> --approval <file> --report <file>\n",
  );
  return 2;
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
