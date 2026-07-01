#!/usr/bin/env node
/**
 * Read-only BlueBubbles inbound verifier for the shared SMS gateway.
 *
 * This does not send SMS. It proves the local bridge can receive BlueBubbles
 * events, forward them to Cloud, and stamps inbound payloads as the shared
 * gateway number.
 */

const defaultBridgeUrl = "http://127.0.0.1:8795";
const expectedGatewayPhoneNumber = "+14159611510";

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-bluebubbles-inbound-readiness.mjs [options]",
    "",
    "Options:",
    "  --bridge-url <url>   Local bridge URL. Defaults to http://127.0.0.1:8795.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    bridgeUrl: defaultBridgeUrl,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--bridge-url") args.bridgeUrl = next().replace(/\/$/, "");
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return args;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok)
    throw new Error(`${url} failed (${response.status}): ${text}`);
  return body;
}

function requireCheck(checks, name) {
  const check = checks.find((entry) => entry.name === name);
  if (!check) throw new Error(`Missing BlueBubbles doctor check: ${name}`);
  if (check.status !== "pass") {
    throw new Error(
      `BlueBubbles ${name} blocked: ${check.detail ?? check.status}`,
    );
  }
  return check;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const doctor = await getJson(`${args.bridgeUrl}/doctor`);
  const diagnostics = await getJson(`${args.bridgeUrl}/diagnostics`);
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];

  for (const name of [
    "bridge",
    "cloud-secret",
    "bluebubbles-server",
    "inbound-webhook",
  ]) {
    requireCheck(checks, name);
  }

  const gatewayPhone = diagnostics?.bridge?.gatewayPhoneNumber;
  if (gatewayPhone !== expectedGatewayPhoneNumber) {
    throw new Error(
      `BlueBubbles bridge gateway identity mismatch: expected ${expectedGatewayPhoneNumber}, got ${gatewayPhone ?? "missing"}`,
    );
  }

  console.log(
    `[bluebubbles-inbound] inbound=pass gateway=${gatewayPhone} webhook=${diagnostics?.blueBubbles?.expectedWebhookUrl ?? "unknown"}`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[bluebubbles-inbound] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
