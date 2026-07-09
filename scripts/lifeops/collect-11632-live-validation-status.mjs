#!/usr/bin/env node
/**
 * Collects the live-validation readiness status for the LifeOps HITL work
 * (issue #11632) by probing each connector group's required env vars (model
 * provider, Google, and others) and writing a status.json under reports/.
 * Reports which connector groups are configured so the live
 * validation run knows what it can actually exercise.
 *
 * CONNECTOR_GROUPS is also imported by the lane driver (run-11632-live-lanes.mjs
 * derives its model gate from the model group), so the CLI body only runs when
 * this file is the entrypoint (import.meta.main). As an entrypoint it hydrates
 * process.env from the layered load shared with the HITL dashboard and lane
 * driver (env-layers.mjs: process.env > repo .env > ~/.eliza/.env), so all
 * three surfaces report the same readiness. The HITL
 * dashboard renders per-auth-path rows from connector-paths.mjs instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLayeredEnvToProcess } from "./env-layers.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_OUT = join(
  ROOT,
  "reports/lifeops-live-validation/11632-status/status.json",
);
const LIFEOPS_REPORT_ROOT = "reports/lifeops-live-validation";

export const CONNECTOR_GROUPS = [
  {
    id: "model",
    label: "Live model provider",
    requiredAny: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CEREBRAS_API_KEY",
      "ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL",
    ],
  },
  {
    id: "google",
    label: "Google Calendar / Gmail",
    requiredAll: [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
    ],
  },
  {
    id: "discord",
    label: "Discord",
    requiredAny: ["DISCORD_API_TOKEN", "DISCORD_BOT_TOKEN"],
  },
  {
    id: "telegram",
    label: "Telegram",
    requiredAll: ["TELEGRAM_BOT_TOKEN"],
    optional: ["TELEGRAM_TEST_CHAT_ID", "TELEGRAM_ALLOWED_CHATS"],
  },
  {
    id: "slack",
    label: "Slack",
    requiredAll: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optional: ["SLACK_USER_TOKEN", "SLACK_CHANNEL_IDS", "SLACK_SIGNING_SECRET"],
  },
  {
    id: "signal",
    label: "Signal",
    requiredAll: ["SIGNAL_ACCOUNT_NUMBER"],
    requiredAny: ["SIGNAL_HTTP_URL", "SIGNAL_CLI_PATH"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    requiredAll: [
      "ELIZA_WHATSAPP_ACCESS_TOKEN",
      "ELIZA_WHATSAPP_PHONE_NUMBER_ID",
    ],
  },
  {
    id: "x",
    label: "X",
    // plugin-x live tests use env-mode OAuth 1.0a; bearer-only cannot satisfy
    // users/me and is not enough to mark the lane ready.
    requiredAll: [
      "TWITTER_API_KEY",
      "TWITTER_API_SECRET_KEY",
      "TWITTER_ACCESS_TOKEN",
      "TWITTER_ACCESS_TOKEN_SECRET",
    ],
  },
  {
    id: "twilio",
    label: "Phone / SMS / Voice",
    requiredAll: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    optional: ["TWILIO_PHONE_NUMBER", "TWILIO_WEBHOOK_URL"],
  },
  {
    id: "health",
    label: "Health",
    requiredAny: [
      "ELIZA_HEALTHKIT_CLI_PATH",
      "ELIZA_GOOGLE_FIT_ACCESS_TOKEN",
      "FITBIT_ACCESS_TOKEN",
      "OURA_ACCESS_TOKEN",
      "STRAVA_ACCESS_TOKEN",
      "WITHINGS_ACCESS_TOKEN",
    ],
  },
  {
    id: "finance",
    label: "Finances",
    requiredAny: [
      "LIFEOPS_FINANCE_CSV_FIXTURE",
      "PLAID_CLIENT_ID",
      "PLAID_SECRET",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ],
  },
  {
    id: "native_ios_macos",
    label: "iOS / macOS native permissions",
    requiredAny: [
      "ELIZA_IMESSAGE_BACKEND",
      "ELIZA_NATIVE_PERMISSIONS_DYLIB",
      "ELIZA_HEALTHKIT_CLI_PATH",
    ],
  },
  {
    id: "native_android",
    label: "Android native permissions",
    requiredAny: ["ANDROID_SERIAL"],
    optional: ["ANDROID_HOME"],
  },
];

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      args.out = resolve(argv[++i]);
    } else if (arg === "--help") {
      console.log(
        "Usage: node scripts/lifeops/collect-11632-live-validation-status.mjs [--out <status.json>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function hasEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    command,
    available: result.status === 0,
    status: result.status,
    signal: result.signal,
    summary: summarizeOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`),
  };
}

function summarizeOutput(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
}

export function groupStatus(group) {
  const requiredAll = group.requiredAll ?? [];
  const requiredAny = group.requiredAny ?? [];
  const optional = group.optional ?? [];
  const present = [...requiredAll, ...requiredAny, ...optional]
    .filter(hasEnv)
    .sort();
  const missingRequiredAll = requiredAll.filter((name) => !hasEnv(name));
  const anySatisfied = requiredAny.length === 0 || requiredAny.some(hasEnv);
  const ready = missingRequiredAll.length === 0 && anySatisfied;
  return {
    id: group.id,
    label: group.label,
    readyForOperatorRun: ready,
    requiredAll,
    requiredAny,
    optional,
    present,
    missingRequiredAll,
    missingRequiredAny:
      requiredAny.length > 0 && !anySatisfied ? requiredAny : [],
  };
}

function adbHasOnlineSerial(adbSummary, serial) {
  if (!serial) return false;
  return adbSummary.split("\n").some((line) => {
    const [deviceSerial, state] = line.trim().split(/\s+/, 2);
    return deviceSerial === serial && state === "device";
  });
}

function applyDeviceReadiness(envGroups, devices) {
  const androidGroup = envGroups.find((group) => group.id === "native_android");
  if (!androidGroup?.readyForOperatorRun) return;

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: evidence collector probes the local operator device outside Turbo tasks.
  const androidSerial = process.env.ANDROID_SERIAL?.trim();
  const online = adbHasOnlineSerial(devices.adb.summary, androidSerial);
  androidGroup.deviceReady = online;
  if (online) return;

  androidGroup.readyForOperatorRun = false;
  androidGroup.missingRequiredAny = [
    ...androidGroup.missingRequiredAny,
    `online adb device${androidSerial ? ` ${androidSerial}` : ""}`,
  ];
}

function fileStatus(path) {
  const full = join(ROOT, path);
  return { path, exists: existsSync(full) };
}

function parseEvidenceLog(path, patterns) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return { path, exists: false, matched: [] };
  const text = readFileSync(full, "utf8");
  return {
    path,
    exists: true,
    matched: patterns.filter((pattern) => pattern.test(text)).map(String),
  };
}

function buildStatus() {
  const envGroups = CONNECTOR_GROUPS.map(groupStatus);
  const existingEvidence = [
    fileStatus(`${LIFEOPS_REPORT_ROOT}/README.md`),
    fileStatus(`${LIFEOPS_REPORT_ROOT}/2026-07-02-keyless-run/README.md`),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/2026-07-02-keyless-run/owner-agent-permission-matrix.txt`,
      [/20\/20 pass/i, /20 passed/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/2026-07-02-keyless-run/connector-keyless-suites.txt`,
      [/all green/i, /pass/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/owner-agent-permission-matrix.txt`,
      [/20\/20 pass/i, /20 passed/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/android-build-after-resolved-appdir.txt`,
      [/BUILD SUCCESSFUL/i, /android sideload artifact audit passed/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/android-app-actions-test.txt`,
      [/12 pass/i, /0 fail/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/biome-edited-files.txt`,
      [/Checked \d+ files/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/core-build-node.txt`,
      [/Node-only build complete/i],
    ),
    parseEvidenceLog(`${LIFEOPS_REPORT_ROOT}/11632-status/core-typecheck.txt`, [
      /tsgo --noEmit -p \.\/tsconfig\.json/i,
    ]),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/agent-typecheck.txt`,
      [/tsgo --noEmit -p tsconfig\.json/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/plugin-discord-typecheck.txt`,
      [/tsgo --noEmit/i],
    ),
    parseEvidenceLog(
      `${LIFEOPS_REPORT_ROOT}/11632-status/plugin-google-live.txt`,
      [/pass/i, /skip/i],
    ),
    parseEvidenceLog(`${LIFEOPS_REPORT_ROOT}/11632-status/plugin-x-live.txt`, [
      /pass/i,
      /skip/i,
    ]),
  ];
  const devices = {
    adb: commandAvailable("adb", ["devices", "-l"]),
    xcrun: commandAvailable("xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
    ]),
    devicectl: commandAvailable("devicectl", ["list", "devices"]),
  };
  applyDeviceReadiness(envGroups, devices);
  const operatorReadyGroups = envGroups.filter(
    (group) => group.readyForOperatorRun,
  );
  const blockedGroups = envGroups.filter((group) => !group.readyForOperatorRun);
  const liveRowsProven = existingEvidence.some(
    (entry) =>
      entry.exists &&
      (entry.path?.includes("plugin-google-live") ||
        entry.path?.includes("plugin-x-live")),
  );

  return {
    issue: 11632,
    generatedAt: new Date().toISOString(),
    verdict: {
      closeable: false,
      reason:
        "This collector is read-only status evidence. #11632 still requires live OAuth/account/device artifacts unless a future run attaches those rows.",
      operatorReadyGroups: operatorReadyGroups.map((group) => group.id),
      blockedGroups: blockedGroups.map((group) => group.id),
      liveRowsProven,
    },
    envGroups,
    devices,
    existingEvidence,
    nextCommands: [
      "LIFEOPS_PERMISSION_MATRIX=1 bunx vitest run --config packages/test/vitest/integration.config.ts plugins/plugin-personal-assistant/test/owner-agent-permission-matrix.integration.test.ts",
      "TEST_LANE=post-merge ELIZA_LIVE_TEST=1 bun run --cwd plugins/plugin-google test",
      "TEST_LANE=post-merge ELIZA_LIVE_TEST=1 bun run --cwd plugins/plugin-x test",
      "bun run dev && bun run --cwd packages/app audit:views",
      "bun run --cwd packages/app capture:android-emu",
      "bun run --cwd packages/app capture:ios-sim",
    ],
  };
}

function renderMarkdown(status) {
  const cell = (value) =>
    String(value || "n/a")
      .replaceAll("|", "\\|")
      .replace(/\r?\n/g, "<br>");
  const rows = status.envGroups
    .map((group) => {
      const required =
        group.requiredAll.length > 0
          ? group.requiredAll.join(", ")
          : `one of: ${group.requiredAny.join(", ")}`;
      const present =
        group.present.length > 0 ? group.present.join(", ") : "none";
      const missing = [
        ...group.missingRequiredAll,
        ...group.missingRequiredAny,
      ].join(", ");
      return `| ${cell(group.label)} | ${group.readyForOperatorRun ? "ready" : "blocked"} | ${cell(required)} | ${cell(present)} | ${cell(missing || "none")} |`;
    })
    .join("\n");
  return `# #11632 LifeOps Live-Validation Status

Generated: ${status.generatedAt}

Verdict: **not closeable**. This is a read-only status artifact; live OAuth,
account, sandbox, and physical-device rows still need operator evidence.

| Surface | Status | Required | Present env names | Missing |
|---|---|---|---|---|
${rows}

## Device Tooling

| Tool | Available | Summary |
|---|---:|---|
| adb | ${status.devices.adb.available ? "yes" : "no"} | ${cell(status.devices.adb.summary)} |
| xcrun | ${status.devices.xcrun.available ? "yes" : "no"} | ${cell(status.devices.xcrun.summary)} |
| devicectl | ${status.devices.devicectl.available ? "yes" : "no"} | ${cell(status.devices.devicectl.summary)} |

## Existing Evidence

${status.existingEvidence.map((entry) => `- ${entry.exists ? "present" : "missing"}: \`${entry.path}\``).join("\n")}
`;
}

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  applyLayeredEnvToProcess();
  const args = parseArgs(process.argv.slice(2));
  const status = buildStatus();
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(
    join(dirname(args.out), "README.md"),
    renderMarkdown(status),
    "utf8",
  );
  console.log(`[11632-status] wrote ${args.out}`);
  console.log(
    `[11632-status] closeable=${status.verdict.closeable} blocked=${status.verdict.blockedGroups.join(",")}`,
  );
}
