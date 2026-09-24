#!/usr/bin/env bun
/**
 * Credential feed for the live multi-account CI lane (#9960).
 *
 * Reads the machine's connected coding-agent credentials — the Codex
 * `~/.codex/auth.json` (refreshed by the owning Codex CLI)
 * and the Claude Code OAuth token — and emits the minimal blobs that
 * `live-multi-account-e2e.ts` seeds the pool from, so a scheduled lane can run
 * real-account rotation. Expired credentials are rejected before output; the
 * exporter never rotates a refresh chain owned by another process.
 *
 * Usage:
 *   bun ../../packages/scripts/plugins/plugin-agent-orchestrator/export-ci-account-secrets.ts [--index N] [--out FILE] [--gh]
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

import {
  appendFileSync,
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
} from "node:fs";
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
    if (a === "--index") {
      const value = argv[++i];
      if (
        !value ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      ) {
        throw new Error("--index requires a positive safe integer");
      }
      args.index = Number(value);
    } else if (a === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--out requires a file path");
      }
      args.out = value;
    } else if (a === "--gh") {
      args.gh = true;
    } else {
      throw new Error(
        "Unsupported argument; use --index N, --out FILE, or --gh",
      );
    }
  }
  return args;
}

function emit(name: string, value: string, args: Args): void {
  // The value itself is never echoed to stdout in --gh mode beyond the command
  // the operator runs locally; the dotenv path is for a trusted runner.
  if (args.out) {
    const output = openSync(args.out, "a", 0o600);
    try {
      // Tighten existing files before writing credential bytes too.
      fchmodSync(output, 0o600);
      appendFileSync(output, `${name}=${value}\n`);
    } finally {
      closeSync(output);
    }
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
  } catch (error) {
    // error-policy:J1 only an absent CLI login is an expected export boundary.
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    console.error(
      `[export] no Codex auth.json at ${authPath} — skipping Codex`,
    );
    return false;
  }
  // The CLI owns this rotating refresh chain. Exporting must not race it by
  // refreshing independently; account-pool adoption owns explicit transfers.
  // Validate it's a usable ChatGPT login before emitting.
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  let parsed: unknown;
  let claims: unknown;
  try {
    parsed = JSON.parse(raw);
    const tokens = isRecord(parsed) ? parsed.tokens : undefined;
    if (
      !isRecord(tokens) ||
      typeof tokens.access_token !== "string" ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token ||
      typeof tokens.account_id !== "string" ||
      !tokens.account_id
    ) {
      throw new Error("Invalid credential fields");
    }
    const payload = tokens.access_token.split(".")[1];
    if (!payload) throw new Error("Missing access-token claims");
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    // error-policy:J3 malformed credential input fails without exposing bytes.
    throw new Error(
      "Codex auth.json is invalid; sign in with the Codex CLI before exporting.",
    );
  }
  if (
    !isRecord(claims) ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now() + 60_000
  ) {
    throw new Error(
      "Codex credentials are expired or lack an expiry; refresh with the owning Codex CLI before exporting.",
    );
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
