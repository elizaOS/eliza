#!/usr/bin/env node
/**
 * CLI for the cross-environment routing verifier.
 *
 * Probes each live custom domain's `/api/health` and asserts the environment
 * that answered matches the environment the domain is supposed to serve -
 * catching "staging is pointing at prod CF" (a staging subdomain that fell into
 * the prod `*.elizacloud.ai/*` Worker wildcard, or a Pages deployment reattached
 * to the wrong environment). See `verify-environment-routing.mjs` for the why.
 *
 * Usage:
 *   node packages/scripts/cloud/verify-environment-routing-cli.mjs \
 *     [--environment staging|production|all]   (default: all)
 *     [--require-beacon]        treat a build-without-beacon as a failure
 *     [--allow-unreachable]     downgrade an unreachable origin to a warning
 *     [--json]                  emit the machine-readable report to stdout
 *
 * Exit code: 0 when every probed domain routed correctly; 1 on any failure
 * (a genuine cross-wire always fails; unreachable/beacon-missing per the flags).
 * A GitHub step summary is appended when $GITHUB_STEP_SUMMARY is set.
 */
import fs from "node:fs";

import {
  classifyProbe,
  decideRoutingVerdict,
  ENVIRONMENT_ROUTING,
  fetchServedEnvironment,
} from "./verify-environment-routing.mjs";

function parseArgs(argv) {
  const out = {
    environment: "all",
    requireBeacon: false,
    requireReachable: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-beacon") out.requireBeacon = true;
    else if (arg === "--allow-unreachable") out.requireReachable = false;
    else if (arg === "--json") out.json = true;
    else if (arg === "--environment") out.environment = argv[++i];
    else if (arg.startsWith("--environment=")) {
      out.environment = arg.slice("--environment=".length);
    }
  }
  return out;
}

const STATUS_LABEL = {
  ok: "ok",
  misrouted: "fail",
  unexpected_env: "warn",
  beacon_missing: "no-beacon",
  unreachable: "unreachable",
};

function stdout(line = "") {
  process.stdout.write(`${line}\n`);
}

function stderr(line = "") {
  process.stderr.write(`${line}\n`);
}

function selectMatrix(environment) {
  if (environment === "all" || !environment) return ENVIRONMENT_ROUTING;
  const target = environment === "prod" ? "production" : environment;
  return ENVIRONMENT_ROUTING.filter((e) => e.environment === target);
}

function writeStepSummary(verdict) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions provides this path.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "### Cross-environment routing verification",
    "",
    `**${verdict.ok ? "PASS" : "FAIL"}** - ${verdict.summary}`,
    "",
    "| Domain | Expected | Answered | Status |",
    "| --- | --- | --- | --- |",
    ...verdict.probes.map(
      (p) =>
        `| \`${p.domain}\` | ${p.expected} | ${p.observed ?? "-"} | ${STATUS_LABEL[p.status] ?? ""} ${p.status} |`,
    ),
    "",
  ];
  if (!verdict.ok) {
    lines.push(
      "> A **misrouted** domain means a staging host is being served by the",
      "> production environment (or vice-versa). Reconcile the Cloudflare Worker",
      "> routes (`packages/cloud/api/wrangler.toml` `[env.staging].routes`) and the",
      "> Pages custom-domain to deployment mapping, then re-run this check.",
      "",
    );
  }
  try {
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  } catch {
    // error-policy:J7 diagnostics-must-not-kill-the-loop - the step summary is
    // auxiliary CI output; the process exit code still carries the verdict.
    // A summary-write failure must never change the verdict.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrix = selectMatrix(args.environment);
  if (matrix.length === 0) {
    stderr(
      `verify-environment-routing: no domains match --environment=${args.environment}`,
    );
    process.exit(2);
  }

  const probes = await Promise.all(
    matrix.map(async ({ domain, environment }) => {
      const { observed, reachable, detail } =
        await fetchServedEnvironment(domain);
      return classifyProbe({
        domain,
        expected: environment,
        observed,
        reachable,
        detail,
      });
    }),
  );

  const verdict = decideRoutingVerdict({
    probes,
    requireBeacon: args.requireBeacon,
    requireReachable: args.requireReachable,
  });

  if (args.json) {
    stdout(JSON.stringify(verdict, null, 2));
  } else {
    for (const p of verdict.probes) {
      const failed = verdict.failures.includes(p);
      const write = failed ? stderr : stdout;
      write(`[${STATUS_LABEL[p.status] ?? "status"}] ${p.message}`);
    }
    stdout("");
    stdout(`${verdict.ok ? "PASS" : "FAIL"}: ${verdict.summary}`);
  }

  writeStepSummary(verdict);
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // error-policy:J1 boundary translation - an unexpected verifier crash must
    // leave CI red instead of being mistaken for healthy routing.
    // An unexpected crash in the verifier itself must NOT be read as "routing
    // is fine": exit non-zero so a broken monitor is visible, not silently green.
    stderr("verify-environment-routing: unexpected error");
    stderr(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

export { parseArgs, selectMatrix };
