/**
 * real-live-suites.mjs
 *
 * Manifest + accounting for every credential/opt-in-guarded `*.real.test.ts` /
 * `*.live.test.ts` suite in the repo (#9310 §6/§E). These suites self-skip via
 * `describe.skipIf`-style guards when a credential, opt-in gate, or host
 * capability is missing — which historically produced a silent green nothing
 * in the post-merge lane.
 *
 * run-all-tests.mjs (TEST_LANE=post-merge) consumes this module to print a
 * loud, named accounting every run:
 *   - which guarded suites are armed (will run live in the sweep),
 *   - which are skipped for missing creds (counted + named, never silent),
 *   - which are opt-in gated / host-probed / config-blocked, and why.
 *
 * The manifest is kept honest mechanically: discoverGuardedRealLiveFiles()
 * re-derives the guarded set from disk, and both the post-merge lane and
 * packages/scripts/__tests__/real-live-suites.test.ts hard-fail on drift
 * (a new guarded suite MUST be added here, a deleted one removed).
 *
 * Entry fields:
 *   file      repo-relative path (manifest key).
 *   requires  env vars that must ALL be non-empty for the suite to run live.
 *   anyOf     groups of env vars; at least one group must be fully satisfied.
 *   optIn     env var that must equal "1" — deliberate operator opt-in gates
 *             that the post-merge lane does NOT auto-set (destructive/heavy).
 *   guardVia  repo-relative helper file(s) where the guard env vars are read
 *             when the suite guards through a shared helper instead of
 *             reading process.env directly (manifest-honesty test follows
 *             these).
 *   probe     host-capability description; the suite self-skips (or runs)
 *             based on a runtime probe, not an env var.
 *   blocked   the package vitest config excludes the file in EVERY lane; the
 *             suite cannot run from the workspace sweep at all. Loudly
 *             reported so it can never be mistaken for coverage.
 *   notes     where else the suite runs (dedicated workflow / lane).
 */

import fs from "node:fs";
import path from "node:path";

/** Same content pattern that defines the guarded set in issue #9310. */
export const GUARD_CONTENT_PATTERN =
  /describe\.skip|requireLiveProvider|ELIZA_LIVE_TEST|COMPUTER_USE_REAL_DESKTOP_TESTS/;

export const REAL_LIVE_FILE_PATTERN = /\.(?:real|live)\.test\.tsx?$/;

const DISCOVERY_SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  ".claude",
  ".codex-pr-worktrees",
  ".codex-worktrees",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export const GUARDED_REAL_LIVE_SUITES = [
  {
    file: "packages/cloud/shared/src/lib/providers/anthropic-thinking.live.test.ts",
    requires: ["ANTHROPIC_API_KEY"],
    optIn: "ELIZA_LIVE_TEST",
    notes:
      "exact cloud resolver request/response trajectory proving Opus 4.7 adaptive thinking reaches Anthropic without budget_tokens",
  },
  {
    file: "packages/agent/src/services/push/push-delivery.real.test.ts",
    anyOf: [["ELIZA_APNS_KEY_ID"], ["ELIZA_FCM_SERVICE_ACCOUNT"]],
    guardVia: [
      "packages/agent/src/services/push/apns-provider.ts",
      "packages/agent/src/services/push/fcm-provider.ts",
    ],
    blocked:
      "packages/agent/vitest.config.ts excludes *.real.test.ts in every deterministic lane; run explicitly via `bunx vitest run --config packages/agent/vitest.push-real.config.ts` with ELIZA_APNS_* / ELIZA_FCM_SERVICE_ACCOUNT set. Real-device delivery is pending-hardware (needs an enrolled device).",
  },
  {
    file: "packages/app-core/src/services/coding-account-bridge.live.test.ts",
    optIn: "ORCHESTRATOR_LIVE_MULTI_ACCOUNT",
    notes: "runs in .github/workflows/orchestrator-live-multi-account.yml",
  },
  {
    file: "packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts",
    optIn: "ELIZA_RUN_LIVE_TESTS",
    requires: ["CEREBRAS_API_KEY"],
  },
  {
    file: "packages/core/src/runtime/__tests__/pii-swap-live-cerebras.real.test.ts",
    requires: ["CEREBRAS_API_KEY"],
  },
  {
    file: "packages/core/src/__tests__/should-respond.live.test.ts",
    optIn: "ELIZA_RUN_LIVE_TESTS",
    probe: "local Ollama at OLLAMA_API_ENDPOINT",
  },
  {
    file: "packages/core/src/features/basic-capabilities/providers/channelTopics.live.test.ts",
    optIn: "ELIZA_LIVE_TEST",
    anyOf: [["OPENAI_API_KEY"], ["CEREBRAS_API_KEY"]],
    notes:
      "real AgentRuntime provider context sent through the configured live text model",
  },
  {
    file: "packages/evidence/src/vision-qa/vision-qa.live.test.ts",
    requires: ["ANTHROPIC_API_KEY"],
    notes:
      "vision-qa VLM screenshot Q&A against the real Anthropic vision model; also armed by ANTHROPIC_LIVE_TEST=1",
  },
  {
    file: "packages/evidence/src/vision-qa/cli-backend.live.test.ts",
    optIn: "ELIZA_VISION_QA_CLI_LIVE",
    notes:
      "vision-qa CLI backend driving a real claude/codex CLI (ELIZA_VISION_QA_CLI selects); spends operator CLI tokens",
  },
  {
    file: "plugins/plugin-agent-orchestrator/__tests__/live/native-acp-smoke.live.test.ts",
    optIn: "RUN_LIVE_NATIVE_ACP",
  },
  {
    file: "plugins/plugin-agent-orchestrator/__tests__/live/sub-agent-router.live.test.ts",
    optIn: "RUN_LIVE_ACPX",
  },
  {
    file: "plugins/plugin-anthropic/__tests__/anthropic-drift.real.test.ts",
    requires: ["ANTHROPIC_API_KEY"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-browser/src/benchmark/__tests__/external-dataset-chromium.real.test.ts",
    probe: "playwright Chromium install",
    notes: "runs in browser-real-bench.yml via test:real:chromium",
  },
  {
    file: "plugins/plugin-browser/src/benchmark/__tests__/miniwob-chromium.real.test.ts",
    probe: "playwright Chromium install",
    notes: "runs in browser-real-bench.yml via test:real:chromium",
  },
  {
    file: "plugins/plugin-browser/src/benchmark/__tests__/web-grounding-chromium.real.test.ts",
    probe: "playwright Chromium install",
    notes: "runs in browser-real-bench.yml via test:real:chromium",
  },
  {
    file: "plugins/plugin-birdclaw/src/birdclaw/birdclaw.real.test.ts",
    blocked:
      "plugin-birdclaw vitest.config.ts excludes *.real.test.ts unless BIRDCLAW_REAL_TESTS=1; run via bun run --cwd plugins/plugin-birdclaw test:real",
    probe: "birdclaw CLI at BIRDCLAW_REAL_BIN or on PATH",
  },
  {
    file: "plugins/plugin-calendar/test/google-calendar-connector.real.test.ts",
    requires: ["GOOGLE_CALENDAR_ACCESS_TOKEN"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-calendly/src/calendly-client.real.test.ts",
    anyOf: [["CALENDLY_ACCESS_TOKEN"], ["ELIZA_E2E_CALENDLY_ACCESS_TOKEN"]],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-computeruse/src/__tests__/benchmark/osworld-local.real.test.ts",
    blocked:
      "plugin-computeruse vitest.config.ts excludes *.real.test.ts in every lane (desktop-control host required)",
    probe: "desktop screenshot capability, non-CI",
  },
  {
    file: "plugins/plugin-computeruse/src/__tests__/benchmark/osworld-tasks.real.test.ts",
    blocked:
      "plugin-computeruse vitest.config.ts excludes *.real.test.ts in every lane (desktop-control host required)",
    optIn: "FORCE_OSWORLD_BENCHMARK",
  },
  {
    file: "plugins/plugin-computeruse/src/__tests__/service.real.test.ts",
    blocked:
      "plugin-computeruse excludes real desktop actuation from every workspace sweep; run this exact file through packages/test/vitest/real.config.ts on an isolated interactive desktop",
    notes:
      "the file itself requires COMPUTER_USE_REAL_DESKTOP_TESTS=1 as a per-command acknowledgment",
  },
  {
    file: "plugins/plugin-computeruse/src/__tests__/windows-list.real.test.ts",
    blocked:
      "plugin-computeruse vitest.config.ts excludes *.real.test.ts in every lane (desktop-control host required)",
    probe: "attached display",
  },
  {
    file: "plugins/plugin-form/src/tests/json-integration.live.test.ts",
    anyOf: [["ANTHROPIC_API_KEY"], ["OPENAI_API_KEY"]],
  },
  {
    file: "plugins/plugin-google-genai/__tests__/integration/google-genai.live.test.ts",
    requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  {
    file: "plugins/plugin-health/test/fitbit-connector.real.test.ts",
    requires: ["FITBIT_ACCESS_TOKEN"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-health/test/oura-connector.real.test.ts",
    requires: ["OURA_ACCESS_TOKEN"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-health/test/strava-connector.real.test.ts",
    requires: ["STRAVA_ACCESS_TOKEN"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-health/test/withings-connector.real.test.ts",
    requires: ["WITHINGS_ACCESS_TOKEN"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-hyperliquid/src/routes.real.test.ts",
    notes:
      "public API, no credential; also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-local-inference/src/services/voice/asr-timed.real.test.ts",
    probe: "bun runtime + built libelizainference + staged voice models",
  },
  {
    file: "plugins/plugin-local-inference/src/services/voice/kokoro/__tests__/kokoro-engine-bridge.real.test.ts",
    probe: "bun runtime + built libelizainference + Kokoro model",
  },
  {
    file: "plugins/plugin-local-inference/src/services/voice/speaker/diarizer-fused.real.test.ts",
    probe: "bun runtime + built libelizainference + diarizer model",
  },
  {
    file: "plugins/plugin-local-inference/src/services/voice/speaker/encoder-fused.real.test.ts",
    probe: "bun runtime + built libelizainference + speaker-encoder model",
  },
  {
    file: "plugins/plugin-ollama/__tests__/native-plumbing.live.test.ts",
    requires: ["OLLAMA_API_ENDPOINT"],
    probe: "reachable local Ollama server",
  },
  {
    file: "plugins/plugin-openai/__tests__/cerebras-spawn-subagent-refusal.live.test.ts",
    optIn: "ELIZA_RUN_LIVE_TESTS",
    requires: ["CEREBRAS_API_KEY"],
  },
  {
    file: "plugins/plugin-openai/__tests__/cerebras-evidence.live.test.ts",
    requires: ["CEREBRAS_API_KEY"],
    notes:
      "credential-redacted raw request/response/SSE, trajectory, tool, structured-output, and provider/transport error evidence",
  },
  {
    file: "plugins/plugin-openai/__tests__/openai-drift.real.test.ts",
    requires: ["OPENAI_API_KEY"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-openai/__tests__/trajectory.live.test.ts",
    requires: ["OPENAI_API_KEY_REAL"],
  },
  {
    file: "plugins/plugin-openrouter/__tests__/models.live.test.ts",
    requires: ["OPENROUTER_API_KEY"],
  },
  {
    file: "plugins/plugin-personal-assistant/test/apple-reminders.live.test.ts",
    blocked:
      "plugin-personal-assistant vitest.config.ts excludes *.live.test.ts in every lane; macOS-only EventKit suite",
    optIn: "ELIZA_LIVE_APPLE_REMINDERS_TEST",
    probe: "macOS host with EventKit access",
  },
  {
    file: "plugins/plugin-personal-assistant/test/lifeops-life-chat.real.test.ts",
    blocked:
      "plugin-personal-assistant vitest.config.ts excludes *.real.test.ts in every lane; run via the PA real lanes (vitest.background-real.config.ts family)",
    anyOf: [
      ["CEREBRAS_API_KEY"],
      ["GROQ_API_KEY"],
      ["OPENAI_API_KEY"],
      ["ANTHROPIC_API_KEY"],
      ["GOOGLE_GENERATIVE_AI_API_KEY"],
    ],
    guardVia: ["packages/app-core/test/helpers/live-provider.ts"],
  },
  {
    file: "plugins/plugin-personal-assistant/test/lifeops-llm-extraction.live.test.ts",
    blocked:
      "plugin-personal-assistant vitest.config.ts excludes *.live.test.ts in every lane; run via the PA real lanes (vitest.background-real.config.ts family)",
    anyOf: [
      ["CEREBRAS_API_KEY"],
      ["GROQ_API_KEY"],
      ["OPENAI_API_KEY"],
      ["ANTHROPIC_API_KEY"],
      ["GOOGLE_GENERATIVE_AI_API_KEY"],
    ],
    guardVia: ["packages/app-core/test/helpers/live-provider.ts"],
  },
  {
    file: "plugins/plugin-polymarket/src/routes.real.test.ts",
    notes:
      "public API, no credential; also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-pty/test/pty.real.test.ts",
    probe: "host PTY support (runs in every lane, POSIX)",
  },
  {
    file: "plugins/plugin-shell/__tests__/shell.real.test.ts",
    probe: "POSIX shell (skips on win32; runs in every lane elsewhere)",
  },
  {
    file: "plugins/plugin-sql/src/__tests__/integration/postgres/rls-entity.real.test.ts",
    requires: ["POSTGRES_URL"],
    notes: "auto-provisioned by run-all-tests.mjs when local psql is available",
  },
  {
    file: "plugins/plugin-sql/src/__tests__/integration/postgres/rls-logs.real.test.ts",
    requires: ["POSTGRES_URL"],
    notes: "auto-provisioned by run-all-tests.mjs when local psql is available",
  },
  {
    file: "plugins/plugin-sql/src/__tests__/integration/postgres/rls-message-server-agents.real.test.ts",
    requires: ["POSTGRES_URL"],
    notes: "auto-provisioned by run-all-tests.mjs when local psql is available",
  },
  {
    file: "plugins/plugin-sql/src/__tests__/integration/postgres/rls-server.real.test.ts",
    requires: ["POSTGRES_URL"],
    notes: "auto-provisioned by run-all-tests.mjs when local psql is available",
  },
  {
    file: "plugins/plugin-vision/src/ocr-service-linux-tesseract.real.test.ts",
    probe: "vendored tesseract binary on linux",
  },
  {
    file: "plugins/plugin-wallet/src/chains/evm/__tests__/integration/rpc-providers.live.test.ts",
    optIn: "ELIZA_LIVE_EVM_RPC_TEST",
    guardVia: [
      "plugins/plugin-wallet/src/chains/evm/__tests__/integration/live-rpc.ts",
    ],
  },
  {
    file: "plugins/plugin-wallet/src/chains/solana/__tests__/integration/birdeye-direct.live.test.ts",
    requires: ["BIRDEYE_API_KEY"],
  },
  {
    file: "plugins/plugin-wallet/src/routes/wallet-market-overview.real.test.ts",
    notes:
      "public CoinGecko API, no credential; also runs nightly in external-api-live-drift.yml",
  },
  {
    file: "plugins/plugin-web-search/src/services/webSearchService.real.test.ts",
    requires: ["TAVILY_API_KEY"],
    notes: "also runs nightly in external-api-live-drift.yml",
  },
];

/**
 * Walk the repo for `*.real.test.ts(x)` / `*.live.test.ts(x)` files whose
 * content matches GUARD_CONTENT_PATTERN — the mechanical definition of the
 * guarded set. Returns repo-relative POSIX paths, sorted.
 */
export function discoverGuardedRealLiveFiles(repoRoot) {
  const found = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!DISCOVERY_SKIP_DIRS.has(entry.name)) {
          stack.push(path.join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !REAL_LIVE_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const content = fs.readFileSync(absolute, "utf8");
      if (GUARD_CONTENT_PATTERN.test(content)) {
        found.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
      }
    }
  }
  return found.sort();
}

/**
 * Compare the on-disk guarded set against the manifest.
 * Returns { unlisted, stale }; both empty means the manifest is current.
 */
export function diffRealLiveManifest(
  discoveredFiles,
  manifest = GUARDED_REAL_LIVE_SUITES,
) {
  const manifestFiles = new Set(manifest.map((entry) => entry.file));
  const discovered = new Set(discoveredFiles);
  return {
    unlisted: discoveredFiles.filter((file) => !manifestFiles.has(file)),
    stale: [...manifestFiles].filter((file) => !discovered.has(file)).sort(),
  };
}

function credGaps(entry, env) {
  const missing = (entry.requires ?? []).filter(
    (name) => !(env[name] ?? "").trim(),
  );
  if (entry.anyOf) {
    const satisfied = entry.anyOf.some((group) =>
      group.every((name) => (env[name] ?? "").trim()),
    );
    if (!satisfied) {
      missing.push(`one of ${entry.anyOf.map((g) => g.join("+")).join(" | ")}`);
    }
  }
  return missing;
}

/**
 * Classify every manifest entry for the given env. Precedence:
 * blocked > optIn (gate unset) > missingCreds > probed > armed.
 */
export function computeRealLiveAccounting(
  env = process.env,
  manifest = GUARDED_REAL_LIVE_SUITES,
) {
  const accounting = {
    blocked: [],
    optIn: [],
    missingCreds: [],
    probed: [],
    armed: [],
  };
  for (const entry of manifest) {
    if (entry.blocked) {
      accounting.blocked.push({ file: entry.file, reason: entry.blocked });
      continue;
    }
    if (entry.optIn && (env[entry.optIn] ?? "").trim() !== "1") {
      accounting.optIn.push({ file: entry.file, gate: entry.optIn });
      continue;
    }
    const missing = credGaps(entry, env);
    if (missing.length > 0) {
      accounting.missingCreds.push({ file: entry.file, missing });
      continue;
    }
    if (entry.probe) {
      accounting.probed.push({ file: entry.file, probe: entry.probe });
      continue;
    }
    accounting.armed.push({ file: entry.file, notes: entry.notes });
  }
  return accounting;
}

/**
 * Render the accounting as `[eliza-test]`-prefixed lines. The
 * "real suites skipped for missing creds" line is emitted on EVERY call —
 * including when the count is 0 — so a green post-merge run always states
 * what it did not cover.
 */
export function formatRealLiveSummaryLines(accounting) {
  const lines = [];
  lines.push(
    `[eliza-test] real/live guarded suites: ${accounting.armed.length} armed, ` +
      `${accounting.missingCreds.length} missing creds, ${accounting.optIn.length} opt-in gated, ` +
      `${accounting.probed.length} host-probed, ${accounting.blocked.length} config-blocked`,
  );
  lines.push(
    `[eliza-test] ${accounting.missingCreds.length} real suites skipped for missing creds:` +
      (accounting.missingCreds.length === 0
        ? " none"
        : `\n${accounting.missingCreds
            .map(
              (item) => `  - ${item.file} (missing ${item.missing.join(", ")})`,
            )
            .join("\n")}`),
  );
  if (accounting.optIn.length > 0) {
    lines.push(
      `[eliza-test] ${accounting.optIn.length} real suites gated behind explicit opt-in (set <GATE>=1 to run):\n` +
        accounting.optIn
          .map((item) => `  - ${item.file} (gate ${item.gate})`)
          .join("\n"),
    );
  }
  if (accounting.probed.length > 0) {
    lines.push(
      `[eliza-test] ${accounting.probed.length} real suites decide via host probe (self-skip when absent):\n` +
        accounting.probed
          .map((item) => `  - ${item.file} (${item.probe})`)
          .join("\n"),
    );
  }
  if (accounting.blocked.length > 0) {
    lines.push(
      `[eliza-test] ${accounting.blocked.length} real suites CONFIG-BLOCKED (excluded by their package vitest config in every lane — NOT covered by this run):\n` +
        accounting.blocked
          .map((item) => `  - ${item.file} (${item.reason})`)
          .join("\n"),
    );
  }
  return lines;
}
