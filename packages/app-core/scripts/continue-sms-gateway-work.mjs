#!/usr/bin/env node
/**
 * Safe continuation cycle for the shared SMS gateway rollout.
 *
 * This keeps production Cloud healthy, checks DNS, watches for Android pairing,
 * and validates BlueBubbles readiness without sending a real SMS/iMessage.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage: node packages/app-core/scripts/continue-sms-gateway-work.mjs [options]",
    "",
    "Options:",
    "  --apply-dns           Apply Porkbun DNS records before checking public readiness.",
    "  --watch-seconds <n>    Android/BlueBubbles watch duration. Defaults to 20.",
    "  --skip-watch           Skip the watch step.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    applyDns: false,
    watchSeconds: 20,
    skipWatch: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--apply-dns") args.applyDns = true;
    else if (arg === "--watch-seconds")
      args.watchSeconds = Number.parseInt(next(), 10);
    else if (arg === "--skip-watch") args.skipWatch = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!Number.isInteger(args.watchSeconds) || args.watchSeconds < 0) {
    throw new Error("--watch-seconds must be a non-negative integer");
  }
  return args;
}

function runStep(
  name,
  command,
  args,
  { allowFailure = false, timeout = 300_000 } = {},
) {
  console.log(`[sms-gateway-continue] step=${name}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) console.log(output);
  const status = result.status ?? (result.error ? 1 : 0);
  if (status !== 0 && !allowFailure) {
    throw new Error(`${name} failed with ${status}`);
  }
  return status;
}

function script(name) {
  return path.join(scriptDir, name);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  runStep("maintain-cloud-prod", "node", [
    script("maintain-cloud-api-production-gateway.mjs"),
  ]);
  runStep("software-contracts", "node", [
    script("test-sms-gateway-software.mjs"),
  ]);
  if (args.applyDns) {
    runStep("homepage-porkbun-dns-apply", "node", [
      script("sync-homepage-porkbun-dns.mjs"),
      "--apply",
    ]);
  }
  runStep(
    "homepage-public",
    "node",
    [script("check-homepage-public-readiness.mjs")],
    {
      allowFailure: true,
    },
  );
  runStep(
    "bluebubbles-validate-no-send",
    "node",
    [script("validate-bluebubbles-outbound.mjs")],
    {
      allowFailure: true,
    },
  );
  if (!args.skipWatch && args.watchSeconds > 0) {
    runStep(
      "watch-physical-gateway",
      "node",
      [
        script("watch-sms-gateway-readiness.mjs"),
        "--timeout",
        String(args.watchSeconds),
        "--interval",
        "5",
        "--run-install",
      ],
      {
        allowFailure: true,
        timeout: (args.watchSeconds + 20) * 1000,
      },
    );
  }
  const status = runStep("status", "node", [script("sms-gateway-status.mjs")], {
    allowFailure: true,
    timeout: 240_000,
  });
  process.exitCode = status;
}

try {
  main();
} catch (error) {
  console.error(
    `[sms-gateway-continue] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
