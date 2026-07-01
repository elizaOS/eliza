#!/usr/bin/env bun
/**
 * Account-readiness CI/ops gate (#9960).
 *
 * Hits GET /api/orchestrator/accounts/readiness on a running runtime and exits
 * non-zero (loud) when the pool lacks ≥1 healthy Codex AND ≥1 healthy Claude
 * (≥2 each with --rotation). This is the loud counterpart to the orchestrator's
 * per-spawn single-account fallback: a degraded pool fails the check instead of
 * silently degrading to one account.
 *
 * Usage:
 *   bun scripts/check-account-readiness.ts [--rotation] [--base http://host:port]
 * Env:
 *   ELIZA_API_BASE   base URL of the runtime HTTP server (default http://127.0.0.1:7777)
 */

interface ProviderReadiness {
  agentType: string;
  total: number;
  enabled: number;
  healthy: number;
  required: number;
  ok: boolean;
}
interface Readiness {
  ready: boolean;
  rotation: boolean;
  required: number;
  providers: ProviderReadiness[];
  problems: string[];
}

function parseArgs(argv: string[]): { rotation: boolean; base: string } {
  let rotation = false;
  let base = process.env.ELIZA_API_BASE ?? "http://127.0.0.1:7777";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rotation") rotation = true;
    else if (a === "--base") base = argv[++i] ?? base;
  }
  return { rotation, base: base.replace(/\/$/, "") };
}

async function main(): Promise<number> {
  const { rotation, base } = parseArgs(process.argv.slice(2));
  const url = `${base}/api/orchestrator/accounts/readiness${rotation ? "?rotation=1" : ""}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(
      `[account-readiness] could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  const body = (await res.json().catch(() => null)) as Readiness | null;
  if (!body) {
    console.error(`[account-readiness] non-JSON response (HTTP ${res.status})`);
    return 2;
  }
  for (const p of body.providers) {
    const mark = p.ok ? "ok" : "FAIL";
    console.log(
      `[account-readiness] ${p.agentType}: ${p.healthy}/${p.required} healthy (${p.total} connected) ${mark}`,
    );
  }
  if (body.ready) {
    console.log(
      `[account-readiness] READY (required >= ${body.required} healthy per provider)`,
    );
    return 0;
  }
  console.error(
    `[account-readiness] NOT READY:\n  - ${body.problems.join("\n  - ")}`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[account-readiness] unexpected error:", err);
    process.exit(2);
  },
);
