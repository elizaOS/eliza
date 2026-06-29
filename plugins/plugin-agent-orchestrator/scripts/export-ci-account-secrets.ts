#!/usr/bin/env bun
/**
 * Credential feed for the live multi-account CI lane (#9960).
 *
 * Reads the machine's connected coding-agent credentials — the Codex
 * `~/.codex/auth.json` (refreshed via the same refresh logic the runtime uses)
 * and the Claude Code OAuth token — and emits the minimal blobs that
 * `live-multi-account-e2e.ts` seeds the pool from, so a scheduled lane can run
 * real-account rotation. Pair this with a scheduled refresh (the Codex token is
 * short-lived) to keep the CI secrets live.
 *
 * Usage:
 *   bun scripts/export-ci-account-secrets.ts [--index N] [--out FILE] [--gh]
 *
 *   --index N   suffix for the emitted var names (default 1) — run once per
 *               connected account, bumping N, to seed 2× each for rotation.
 *   --out FILE  append `NAME=value` lines to FILE (a dotenv for the runner).
 *   --gh        print `gh secret set` commands (review before running).
 *
 * Env overrides:
 *   CODEX_AUTH_PATH               path to auth.json (default ~/.codex/auth.json)
 *   CLAUDE_CODE_OAUTH_TOKEN       the Claude token to export (else skipped)
 *
 * Secrets are printed to stdout — run in a trusted shell, never in CI logs.
 */

import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface Args {
  index: number;
  out?: string;
  gh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { index: 1, gh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--index")
      args.index = Number.parseInt(argv[++i] ?? "1", 10) || 1;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--gh") args.gh = true;
  }
  return args;
}

function emit(name: string, value: string, args: Args): void {
  // The value itself is never echoed to stdout in --gh mode beyond the command
  // the operator runs locally; the dotenv path is for a trusted runner.
  if (args.out) {
    appendFileSync(args.out, `${name}=${value}\n`);
    console.log(`[export] wrote ${name} -> ${args.out}`);
  }
  if (args.gh) {
    console.log(
      `gh secret set ${name} --body '${value.replace(/'/g, "'\\''")}'`,
    );
  }
  if (!args.out && !args.gh) {
    console.log(`${name}=${value}`);
  }
}

async function exportCodex(args: Args): Promise<boolean> {
  const authPath =
    process.env.CODEX_AUTH_PATH ??
    path.join(os.homedir(), ".codex", "auth.json");
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf-8");
  } catch {
    console.error(
      `[export] no Codex auth.json at ${authPath} — skipping Codex`,
    );
    return false;
  }
  // Refresh in place if expired, using the runtime's own refresh logic, so the
  // exported blob is fresh for the lane.
  try {
    const { loadCodexAuth, isExpired, refreshCodexAuth } = await import(
      "../../plugin-codex-cli/src/codex-auth.ts"
    );
    const auth = await loadCodexAuth(authPath);
    if (isExpired(auth)) {
      console.error("[export] Codex token expired — refreshing");
      await refreshCodexAuth(auth, authPath);
      raw = readFileSync(authPath, "utf-8");
    }
  } catch (err) {
    console.error(
      `[export] Codex refresh skipped (${err instanceof Error ? err.message : String(err)}); exporting current blob`,
    );
  }
  // Validate it's a usable ChatGPT login before emitting.
  const parsed = JSON.parse(raw);
  if (!parsed?.tokens?.access_token || !parsed?.tokens?.account_id) {
    console.error("[export] Codex auth.json is not a ChatGPT login — skipping");
    return false;
  }
  emit(
    `ELIZA_LIVE_CODEX_AUTH_JSON_${args.index}`,
    JSON.stringify(parsed),
    args,
  );
  return true;
}

function exportClaude(args: Args): boolean {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!token) {
    console.error(
      "[export] CLAUDE_CODE_OAUTH_TOKEN not set — skipping Claude (set it to export)",
    );
    return false;
  }
  emit(`ELIZA_LIVE_CLAUDE_OAUTH_TOKEN_${args.index}`, token, args);
  return true;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const codex = await exportCodex(args);
  const claude = exportClaude(args);
  if (!codex && !claude) {
    console.error(
      "[export] nothing exported — no connected Codex or Claude credential found",
    );
    return 1;
  }
  console.error(
    `[export] done (index ${args.index}): codex=${codex} claude=${claude}`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[export] error:", err);
    process.exit(2);
  },
);
