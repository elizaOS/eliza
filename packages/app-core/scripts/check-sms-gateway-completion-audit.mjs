#!/usr/bin/env node
/**
 * Read-only completion audit for the shared Eliza Cloud SMS gateway objective.
 *
 * This does not send SMS. It runs the existing readiness/verifier commands and
 * prints which objective requirements are currently proven versus externally
 * blocked.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const packagesRoot = path.join(repoRoot, "packages");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const defaultEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "sms-gateway-completion-audit-latest.json",
);
const localEvidenceRoot = path.join(repoRoot, ".eliza-local");
const supplementalEvidenceByCheck = {
  "homepage-public-dns": [
    path.join(localEvidenceRoot, "homepage-public-readiness-latest.json"),
  ],
  "android-transport": [
    path.join(localEvidenceRoot, "android-sms-gateway-e2e-latest.json"),
  ],
  "bluebubbles-transport": [
    path.join(localEvidenceRoot, "bluebubbles-outbound-validation-latest.json"),
    path.join(localEvidenceRoot, "bluebubbles-gateway-e2e-latest.json"),
  ],
};

function usage() {
  return [
    "Usage: node packages/app-core/scripts/check-sms-gateway-completion-audit.mjs [options]",
    "",
    "Options:",
    "  --evidence <path>  Write structured proof JSON. Defaults to .eliza-local/sms-gateway-completion-audit-latest.json.",
    "  --no-evidence      Do not write a proof JSON file.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    evidencePath: defaultEvidencePath,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--evidence") args.evidencePath = path.resolve(next());
    else if (arg === "--no-evidence") args.evidencePath = null;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

const checks = [
  {
    key: "homepage-bundle",
    label:
      "published homepage bundle points users at the shared gateway number",
    command: ["node", ["./scripts/check-homepage-public-readiness.mjs"]],
    pass: (result) =>
      /PASS homepage-bundle: .*gateway=yes personal-number=no/.test(
        result.output,
      ),
  },
  {
    key: "homepage-public-dns",
    label: "public eliza.app domain resolves to the published homepage",
    command: ["node", ["./scripts/check-homepage-public-readiness.mjs"]],
    pass: (result) =>
      result.status === 0 &&
      /PASS pages-source:/.test(result.output) &&
      /PASS gh-pages-cname:/.test(result.output) &&
      /PASS homepage-bundle:/.test(result.output) &&
      /PASS registry-status:/.test(result.output) &&
      /PASS domain-delegation:/.test(result.output) &&
      /PASS apex-dns:/.test(result.output) &&
      /PASS www-dns:/.test(result.output),
    blocked: (result) =>
      /BLOCKED registry-status|BLOCKED apex-dns|BLOCKED www-dns|client hold/.test(
        result.output,
      ),
    blockedDetail: "registrar/DNS is not ready for eliza.app",
    next: [
      "clear client hold at Porkbun/registrar",
      "with Porkbun API credentials, run: bun run --cwd packages/app-core sms-gateway:homepage:dns -- --apply",
      "add A eliza.app -> 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153",
      "add CNAME www.eliza.app -> elizaos.github.io.",
      "rerun: bun run --cwd packages/app-core sms-gateway:homepage",
    ],
  },
  {
    key: "cloud-onboarding",
    label:
      "production Cloud API routes unknown sender to onboarding through +14159611510/bluebubbles/blooio, gets product/pricing/$5 credit and login link",
    command: ["node", ["./scripts/verify-cloud-api-production-deploy.mjs"]],
    pass: (result) =>
      result.status === 0 &&
      /gateway=\+14159611510 registered=yes/.test(result.output) &&
      /gatewayId=[0-9a-f-]{36}/.test(result.output) &&
      /device=\+14159611510\/bluebubbles\/blooio/.test(result.output) &&
      /first=handled second=login-link continuation=200/.test(result.output) &&
      /\[cloud-api-prod\] PASS/.test(result.output),
    next: [
      "repair production deploy: bun run --cwd packages/app-core sms-gateway:deploy:cloud-prod",
    ],
  },
  {
    key: "routing-contracts",
    label:
      "known-owner priority, friend-contact routing, and contact recording contracts pass",
    command: [
      "bun",
      [
        "test",
        path.join(
          packagesRoot,
          "cloud",
          "shared",
          "src",
          "lib",
          "services",
          "phone-gateway-devices.test.ts",
        ),
        path.join(
          packagesRoot,
          "cloud",
          "shared",
          "src",
          "lib",
          "services",
          "agent-gateway-router.test.ts",
        ),
        path.join(
          packagesRoot,
          "cloud",
          "shared",
          "src",
          "lib",
          "services",
          "message-router",
          "index.test.ts",
        ),
      ],
    ],
    cwd: () => createBunTestCwd("sms-gateway-routing-audit-"),
    pass: (result) =>
      result.status === 0 &&
      /phone-gateway-devices\.test\.ts/.test(result.output) &&
      /agent-gateway-router\.test\.ts/.test(result.output) &&
      /message-router\/index\.test\.ts/.test(result.output) &&
      /16 pass/.test(result.output) &&
      /0 fail/.test(result.output),
    blocked: (result) =>
      /Cannot find module '@elizaos\/core'|Cannot find package '@elizaos\/core'|WriteFailed/.test(
        result.output,
      ),
    blockedDetail:
      "linked workspace test runtime is not built or Bun coverage output failed",
    next: [
      "build linked workspaces: bun run --cwd packages/cloud/shared build:linked-workspaces",
      "rerun: bun run --cwd packages/app-core sms-gateway:status",
    ],
  },
  {
    key: "provisioning-handoff",
    label:
      "post-login provisioning grants starter credit and copies onboarding transcript into agent memory",
    command: [
      "bun",
      [
        "test",
        path.join(
          packagesRoot,
          "cloud",
          "shared",
          "src",
          "lib",
          "services",
          "eliza-app",
          "onboarding-chat.test.ts",
        ),
        path.join(
          packagesRoot,
          "cloud",
          "shared",
          "src",
          "lib",
          "services",
          "eliza-app",
          "provisioning.test.ts",
        ),
        "--reporter=dots",
      ],
    ],
    cwd: () => createBunTestCwd("sms-gateway-provisioning-"),
    pass: (result) =>
      result.status === 0 &&
      /\d+ pass/.test(result.output) &&
      /0 fail/.test(result.output),
  },
  {
    key: "android-apk",
    label:
      "Android SMS gateway APK is built and has the required gateway manifest surface",
    command: [
      "node",
      ["./scripts/install-android-sms-gateway.mjs", "--doctor"],
    ],
    pass: (result) =>
      /PASS apk: .*eliza-android-sms-gateway-debug\.apk/.test(result.output) &&
      /PASS apk-manifest: SMS gateway manifest surface is present/.test(
        result.output,
      ),
  },
  {
    key: "android-transport",
    label: "Android physical SMS gateway is installed and physically verified",
    command: [
      "node",
      [
        "./scripts/verify-android-sms-gateway-e2e.mjs",
        "--wait-device",
        "2",
        "--timeout",
        "1",
      ],
    ],
    pass: (result) =>
      result.status === 0 &&
      /Physical Android SMS gateway verification passed/.test(result.output),
    blocked: (result) =>
      /Timed out waiting .* for an adb device|Missing SMS gateway milestones/.test(
        result.output,
      ),
    blockedDetail:
      "Android phone is not paired/connected and physical SMS milestones are not proven",
    next: [
      "open Android Developer Options > Wireless debugging > Pair device with pairing code",
      "leave this running while opening the pairing screen: bun run --cwd packages/app-core sms-gateway:watch:pair",
      "rerun: bun run --cwd packages/app-core sms-gateway:pair",
      "then verify physical SMS: bun run --cwd packages/app-core sms-gateway:verify",
    ],
  },
  {
    key: "bluebubbles-inbound",
    label:
      "BlueBubbles fallback bridge can receive and forward inbound events to Cloud as +14159611510",
    command: ["node", ["./scripts/verify-bluebubbles-inbound-readiness.mjs"]],
    pass: (result) =>
      result.status === 0 &&
      /gateway=\+14159611510/.test(result.output) &&
      /inbound=pass/.test(result.output),
    blocked: (result) =>
      /bridge|cloud-secret|bluebubbles-server|inbound-webhook|gateway/.test(
        result.output,
      ),
    blockedDetail:
      "BlueBubbles bridge, server, cloud secret, or inbound webhook is not ready",
    next: [
      "rerun bridge doctor: bun run --cwd packages/app-core sms-gateway:doctor",
    ],
  },
  {
    key: "bluebubbles-transport",
    label: "BlueBubbles fallback outbound path is real-send validated",
    command: ["bun", ["run", "sms-gateway:validate:bluebubbles"]],
    pass: (result) =>
      result.status === 0 && /PASS .* validated at/.test(result.output),
    blocked: (result) =>
      /Refusing to send without --confirm-real-send|Shortcut outbound validation missing/.test(
        result.output,
      ),
    blockedDetail:
      "real outbound validation send has not been explicitly confirmed",
    next: [
      "after explicit real-send approval, run: bun run --cwd packages/app-core sms-gateway:validate:bluebubbles -- --confirm-real-send",
      "then verify pending egress: bun run --cwd packages/app-core sms-gateway:verify:bluebubbles",
    ],
  },
];

function createBunTestCwd(prefix) {
  const tmpRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(tmpRoot, prefix));
  fs.writeFileSync(
    path.join(cwd, "bunfig.toml"),
    "[test]\ntimeout = 60000\ncoverage = false\n",
  );
  return cwd;
}

function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function run(command, args, { cwd = appCoreRoot } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

function redactOutput(output) {
  return oneLine(output).slice(0, 1200);
}

function summarizeEvidenceJson(value) {
  if (!value || typeof value !== "object") return value;
  const summary = {};
  for (const key of [
    "ok",
    "checkedAt",
    "blocker",
    "doctorStatus",
    "recipient",
    "gatewayPhoneNumber",
    "pairingEndpointAdvertised",
    "connectEndpointAdvertised",
    "pendingBefore",
    "pendingAfter",
    "sentCount",
    "error",
  ]) {
    if (Object.hasOwn(value, key)) {
      summary[key] = value[key];
    }
  }
  if (Array.isArray(value.blocked)) summary.blocked = value.blocked;
  if (Array.isArray(value.proven)) summary.proven = value.proven;
  if (Array.isArray(value.checks)) {
    summary.blockedChecks = value.checks
      .filter((check) => check && check.passed === false)
      .map((check) => ({
        name: check.name,
        detail: check.detail,
      }));
  }
  if (value.details && typeof value.details === "object") {
    for (const key of [
      "registryStatuses",
      "registryNameservers",
      "delegatedNameservers",
      "apexRecords",
      "wwwCnames",
    ]) {
      if (Object.hasOwn(value.details, key)) {
        summary[key] = value.details[key];
      }
    }
  }
  if (typeof value.next === "string") summary.next = value.next;
  return summary;
}

function readSupplementalEvidence(key) {
  return (supplementalEvidenceByCheck[key] ?? []).map((evidencePath) => {
    if (!fs.existsSync(evidencePath)) {
      return { path: evidencePath, exists: false, summary: null };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      return {
        path: evidencePath,
        exists: true,
        summary: summarizeEvidenceJson(parsed),
      };
    } catch (error) {
      return {
        path: evidencePath,
        exists: true,
        summary: { error: `failed to parse evidence JSON: ${error.message}` },
      };
    }
  });
}

function writeEvidence({ evidencePath, ok, results }) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    ok,
    checkedAt: new Date().toISOString(),
    gatewayPhoneNumber: "+14159611510",
    proven: results
      .filter((result) => result.status === "proven")
      .map((result) => result.key),
    blocked: results
      .filter((result) => result.status === "blocked")
      .map((result) => result.key),
    requirements: results,
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[sms-gateway-audit] evidence=${evidencePath}`);
}

const args = parseArgs(process.argv.slice(2));
const evidenceResults = [];
let blocked = false;
for (const check of checks) {
  const [command, args] = check.command;
  const cwd = check.cwd?.();
  const result = run(command, args, { cwd });
  if (cwd) removePathRecursive(cwd);
  const passed = check.pass(result);
  const isBlocked = !passed && check.blocked?.(result);
  if (passed) {
    console.log(`[sms-gateway-audit] PROVEN ${check.key}: ${check.label}`);
    evidenceResults.push({
      key: check.key,
      label: check.label,
      status: "proven",
      command: [command, ...args].join(" "),
      exitCode: result.status,
      detail: redactOutput(result.output),
      evidence: readSupplementalEvidence(check.key),
      next: [],
    });
    continue;
  }

  blocked = true;
  const detail = isBlocked
    ? check.blockedDetail
    : oneLine(result.output).slice(0, 240) || `exit ${result.status}`;
  console.log(
    `[sms-gateway-audit] BLOCKED ${check.key}: ${check.label}; ${detail}`,
  );
  for (const next of check.next ?? []) {
    console.log(`[sms-gateway-audit] NEXT ${check.key}: ${next}`);
  }
  evidenceResults.push({
    key: check.key,
    label: check.label,
    status: "blocked",
    command: [command, ...args].join(" "),
    exitCode: result.status,
    detail,
    rawSummary: redactOutput(result.output),
    evidence: readSupplementalEvidence(check.key),
    next: check.next ?? [],
  });
}

if (blocked) {
  console.log(
    "[sms-gateway-audit] status=blocked physical/end-to-end completion is not proven.",
  );
  writeEvidence({
    evidencePath: args.evidencePath,
    ok: false,
    results: evidenceResults,
  });
  process.exitCode = 1;
} else {
  console.log(
    "[sms-gateway-audit] status=complete all objective requirements are currently proven.",
  );
  writeEvidence({
    evidencePath: args.evidencePath,
    ok: true,
    results: evidenceResults,
  });
}
