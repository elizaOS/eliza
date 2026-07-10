#!/usr/bin/env bun
import { collectIMessageCorpus } from "./collectors/imessage.ts";
/**
 * Command-line boundary for corpus validation. The library returns structured
 * diagnostics; this file is the only place that prints and converts validation
 * failure into a process exit code.
 */
import {
  runScrubPipeline,
  type ScrubMode,
  type ScrubStageSelector,
} from "./pipeline/driver.ts";
import { validateCorpusTarget } from "./validator.ts";
import { type VerifyCorpusOptions, verifyCorpus } from "./verification.ts";

interface ScrubCliOptions {
  targetPath: string;
  stage: ScrubStageSelector;
  mode: ScrubMode;
  resume: boolean;
  dryRun: boolean;
  rulesetVersion: string;
  stateDir?: string;
  ledgerPath?: string;
  outputPath?: string;
  reportPath?: string;
}

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

function readIsoTimestamp(args: string[], flag: string): number | undefined {
  const value = readFlagValue(args, flag);
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp))
    throw new Error(`${flag} must be an ISO timestamp`);
  return timestamp;
}

function parseVerifyCliOptions(args: string[]): VerifyCorpusOptions {
  return {
    targetPath: requireFlagValue(args, "--target"),
    manifestPath: requireFlagValue(args, "--manifest"),
    candidatesPath: requireFlagValue(args, "--candidates"),
    canariesPath: requireFlagValue(args, "--canaries"),
    ledgerPath: requireFlagValue(args, "--ledger"),
    gazetteerPath: requireFlagValue(args, "--gazetteer"),
    deletionRulesPath: requireFlagValue(args, "--deletion-rules"),
    deletionReviewQueuePath: requireFlagValue(args, "--deletion-review-queue"),
    deletionReviewDecisionPath: requireFlagValue(
      args,
      "--deletion-review-decision",
    ),
    deletionApprovalPath: requireFlagValue(args, "--deletion-approval"),
    placeholderRegistryPath: requireFlagValue(args, "--placeholder-registry"),
    rulesetVersion: requireFlagValue(args, "--ruleset-version"),
    reportPath: requireFlagValue(args, "--report"),
    gitleaksBinaryPath: readFlagValue(args, "--gitleaks-binary"),
    gitleaksConfigPath: readFlagValue(args, "--gitleaks-config"),
  };
}

function parseScrubCliOptions(args: string[]): ScrubCliOptions {
  const stage = readFlagValue(args, "--stage") ?? "all";
  const mode = readFlagValue(args, "--mode") ?? "deep";
  if (
    !["all", "mine", "secrets", "delete", "rewrite", "llm", "verify"].includes(
      stage,
    )
  ) {
    throw new Error(`invalid --stage ${stage}`);
  }
  if (mode !== "fast-track" && mode !== "deep") {
    throw new Error(`invalid --mode ${mode}`);
  }
  return {
    targetPath: readFlagValue(args, "--target") ?? "data",
    stage: stage as ScrubStageSelector,
    mode,
    resume: args.includes("--resume"),
    dryRun: args.includes("--dry-run"),
    rulesetVersion: readFlagValue(args, "--ruleset-version") ?? "1",
    stateDir: readFlagValue(args, "--state-dir"),
    ledgerPath: readFlagValue(args, "--ledger"),
    outputPath: readFlagValue(args, "--output"),
    reportPath: readFlagValue(args, "--report"),
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, maybeTarget = "data", ...rest] = argv;
  if (command === "validate") {
    const result = await validateCorpusTarget(maybeTarget);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (command === "scrub") {
    const options = parseScrubCliOptions([maybeTarget, ...rest]);
    const result = await runScrubPipeline(options);
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  }

  if (command === "verify") {
    const result = await verifyCorpus(
      parseVerifyCliOptions([maybeTarget, ...rest]),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "passed" ? 0 : 1;
  }

  if (command === "collect") {
    if (maybeTarget !== "imessage")
      throw new Error("corpus collect currently supports imessage");
    const pageSizeValue = readFlagValue(rest, "--page-size");
    const pageSize =
      pageSizeValue === undefined ? undefined : Number(pageSizeValue);
    const result = await collectIMessageCorpus({
      outputRoot: requireFlagValue(rest, "--output"),
      stateDir: requireFlagValue(rest, "--state-dir"),
      accountId: requireFlagValue(rest, "--account-id"),
      ownerId: requireFlagValue(rest, "--owner-id"),
      ownerDisplay: requireFlagValue(rest, "--owner-display"),
      ownerAddress: readFlagValue(rest, "--owner-address"),
      dbPath: readFlagValue(rest, "--db"),
      attachmentRoot: readFlagValue(rest, "--attachment-root"),
      sinceMs: readIsoTimestamp(rest, "--since"),
      untilMs: readIsoTimestamp(rest, "--until"),
      pageSize,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(
    "usage: corpus validate <file-or-dir>\n       corpus scrub --target <file-or-dir> --stage <stage|all> --mode <deep|fast-track> [--resume] [--dry-run]\n       corpus collect imessage --output <dir> --state-dir <dir> --account-id <slug> --owner-id <id> --owner-display <name> [--owner-address <address>] [--db <chat.db>] [--attachment-root <dir>] [--since <iso>] [--until <iso>] [--page-size <1..1000>]\n       corpus verify --target <dir> --manifest <file> --candidates <file> --canaries <file> --ledger <file> --gazetteer <file> --deletion-rules <file> --deletion-review-queue <file> --deletion-review-decision <file> --deletion-approval <file> --placeholder-registry <file> --ruleset-version <version> --report <file>\n",
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
