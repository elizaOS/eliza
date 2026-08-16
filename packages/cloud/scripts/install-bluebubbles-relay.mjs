#!/usr/bin/env node

/**
 * Installs and diagnoses the dedicated-macOS BlueBubbles relay LaunchAgent.
 * The installer validates a strict, mode-0600 environment file before launch,
 * keeps credentials out of the plist and terminal output, and exposes an
 * idempotent install/status/doctor/uninstall lifecycle for operators.
 */

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_LABEL = "ai.elizacloud.bluebubbles-bridge";
export const DEFAULT_RELAY_PORT = 8795;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, "../../..");
const requiredEnvironmentKeys = [
  "ELIZA_CLOUD_BLUEBUBBLES_URL",
  "BLUEBUBBLES_BRIDGE_ID",
  "BLUEBUBBLES_GATEWAY_TOKEN",
  "BLUEBUBBLES_GATEWAY_PHONE_NUMBER",
  "BLUEBUBBLES_SEND_METHOD",
  "BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED",
  "BLUEBUBBLES_PENDING_RETRY_ENABLED",
];

function usage() {
  return [
    "Usage: node packages/cloud/scripts/install-bluebubbles-relay.mjs <command> [options]",
    "",
    "Commands:",
    "  install     Validate configuration, render the LaunchAgent, and start it.",
    "  status      Report service and relay readiness without exposing identities.",
    "  doctor      Run strict local and relay readiness checks.",
    "  uninstall   Stop the service and remove only the generated LaunchAgent.",
    "",
    "Options:",
    "  --env-file <path>  Relay environment file.",
    "  --plist <path>     LaunchAgent plist path.",
    "  --repo-root <path> Repository checkout to run.",
    "  --bun <path>       Absolute Bun executable path.",
    "  --port <number>    Relay health port (default 8795).",
    "  --json             Emit JSON.",
  ].join("\n");
}

export function parseArguments(argv, defaults = {}) {
  const repoRoot = defaults.repoRoot ?? defaultRepoRoot;
  let envFileExplicit = Boolean(defaults.envFile);
  const args = {
    command: "",
    repoRoot,
    envFile:
      defaults.envFile ??
      path.join(repoRoot, ".eliza-local", "bluebubbles-bridge.env"),
    plist:
      defaults.plist ??
      path.join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    bunPath: defaults.bunPath ?? "",
    port: defaults.port ?? DEFAULT_RELAY_PORT,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (
      !args.command &&
      ["install", "status", "doctor", "uninstall"].includes(argument)
    ) {
      args.command = argument;
    } else if (argument === "--repo-root") {
      args.repoRoot = path.resolve(next());
    } else if (argument === "--env-file") {
      args.envFile = path.resolve(next());
      envFileExplicit = true;
    } else if (argument === "--plist") {
      args.plist = path.resolve(next());
    } else if (argument === "--bun") {
      args.bunPath = path.resolve(next());
    } else if (argument === "--port") {
      args.port = Number.parseInt(next(), 10);
    } else if (argument === "--json") {
      args.json = true;
    } else if (argument === "--help" || argument === "-h") {
      return { ...args, command: "help" };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!args.command) throw new Error(usage());
  if (!envFileExplicit) {
    args.envFile = path.join(
      args.repoRoot,
      ".eliza-local",
      "bluebubbles-bridge.env",
    );
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return args;
}

function decodeEnvironmentValue(rawValue, lineNumber) {
  if (!rawValue)
    throw new Error(`Environment line ${lineNumber} has an empty value`);
  if (rawValue.startsWith("'")) {
    if (!rawValue.endsWith("'") || rawValue.length < 2) {
      throw new Error(
        `Environment line ${lineNumber} has an unterminated single quote`,
      );
    }
    const value = rawValue.slice(1, -1);
    if (value.includes("'")) {
      throw new Error(
        `Environment line ${lineNumber} contains an unsupported single quote`,
      );
    }
    return value;
  }
  if (rawValue.startsWith('"')) {
    if (!rawValue.endsWith('"') || rawValue.length < 2) {
      throw new Error(
        `Environment line ${lineNumber} has an unterminated double quote`,
      );
    }
    const value = rawValue.slice(1, -1);
    if (/[\\$`]/.test(value)) {
      throw new Error(
        `Environment line ${lineNumber} uses shell expansion or escaping; use a single-quoted literal`,
      );
    }
    return value;
  }
  if (!/^[A-Za-z0-9_./:+?%=&@-]+$/.test(rawValue)) {
    throw new Error(
      `Environment line ${lineNumber} contains shell syntax; use a single-quoted literal value`,
    );
  }
  return rawValue;
}

export function parseRelayEnvironment(source) {
  const parsed = {};
  const seen = new Set();
  for (const [zeroBasedLine, originalLine] of source.split(/\r?\n/).entries()) {
    const lineNumber = zeroBasedLine + 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(
        `Environment line ${lineNumber} is not a KEY=VALUE assignment`,
      );
    }
    const [, key, rawValue] = match;
    if (seen.has(key)) throw new Error(`Environment key ${key} is duplicated`);
    seen.add(key);
    parsed[key] = decodeEnvironmentValue(rawValue.trim(), lineNumber);
  }
  return parsed;
}

export function validateRelayEnvironment(environment) {
  const issues = [];
  for (const key of requiredEnvironmentKeys) {
    if (!environment[key]) issues.push(`${key} is required`);
  }
  if (environment.BLUEBUBBLES_GATEWAY_SECRET) {
    issues.push(
      "BLUEBUBBLES_GATEWAY_SECRET is forbidden for a registered-device install",
    );
  }
  if (
    environment.BLUEBUBBLES_GATEWAY_PHONE_NUMBER &&
    !/^\+[1-9]\d{7,14}$/.test(environment.BLUEBUBBLES_GATEWAY_PHONE_NUMBER)
  ) {
    issues.push("BLUEBUBBLES_GATEWAY_PHONE_NUMBER must be E.164");
  }
  if (
    environment.BLUEBUBBLES_BRIDGE_ID &&
    !/^bb-[A-Za-z0-9-]{8,}$/.test(environment.BLUEBUBBLES_BRIDGE_ID)
  ) {
    issues.push("BLUEBUBBLES_BRIDGE_ID is not a registered bridge id");
  }
  if (
    environment.BLUEBUBBLES_GATEWAY_TOKEN &&
    !/^bbg_[a-f0-9]{64}$/.test(environment.BLUEBUBBLES_GATEWAY_TOKEN)
  ) {
    issues.push("BLUEBUBBLES_GATEWAY_TOKEN is not a registered-device token");
  }
  if (
    environment.BLUEBUBBLES_SEND_METHOD &&
    environment.BLUEBUBBLES_SEND_METHOD !== "private-api"
  ) {
    issues.push(
      "BLUEBUBBLES_SEND_METHOD must be private-api on the dedicated Mac",
    );
  }
  if (
    environment.BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED &&
    environment.BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED !== "false"
  ) {
    issues.push("BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED must be false");
  }
  if (
    environment.BLUEBUBBLES_PENDING_RETRY_ENABLED &&
    environment.BLUEBUBBLES_PENDING_RETRY_ENABLED !== "false"
  ) {
    issues.push(
      "BLUEBUBBLES_PENDING_RETRY_ENABLED must be false until delivery is supervised",
    );
  }

  if (environment.BLUEBUBBLES_SERVER_URL) {
    try {
      const serverUrl = new URL(environment.BLUEBUBBLES_SERVER_URL);
      if (
        serverUrl.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "::1"].includes(serverUrl.hostname)
      ) {
        issues.push("BLUEBUBBLES_SERVER_URL must use loopback HTTP");
      }
    } catch {
      // error-policy:J3 malformed operator configuration is an explicit invalid result.
      issues.push("BLUEBUBBLES_SERVER_URL is not a valid URL");
    }
  }

  if (environment.ELIZA_CLOUD_BLUEBUBBLES_URL) {
    try {
      const cloudUrl = new URL(environment.ELIZA_CLOUD_BLUEBUBBLES_URL);
      const expectedSuffix = `/api/webhooks/bluebubbles/${encodeURIComponent(
        environment.BLUEBUBBLES_BRIDGE_ID ?? "",
      )}`;
      if (cloudUrl.protocol !== "https:") {
        issues.push("ELIZA_CLOUD_BLUEBUBBLES_URL must use HTTPS");
      }
      if (cloudUrl.pathname !== expectedSuffix) {
        issues.push(
          "ELIZA_CLOUD_BLUEBUBBLES_URL does not match BLUEBUBBLES_BRIDGE_ID",
        );
      }
    } catch {
      // error-policy:J3 malformed operator configuration is an explicit invalid result.
      issues.push("ELIZA_CLOUD_BLUEBUBBLES_URL is not a valid URL");
    }
  }
  return issues;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist({
  repoRoot,
  envFile,
  bunPath,
  stdoutPath,
  stderrPath,
}) {
  const bridgeScript = path.join(
    repoRoot,
    "packages",
    "cloud",
    "scripts",
    "bluebubbles-local-bridge.ts",
  );
  const command = [
    "set -a",
    `source ${shellQuote(envFile)}`,
    "set +a",
    `exec ${shellQuote(bunPath)} run ${shellQuote(bridgeScript)}`,
  ].join("; ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

async function regularFile(pathname, label) {
  const details = await stat(pathname).catch((error) => {
    // error-policy:J2 add the required artifact name and preserve the filesystem cause.
    throw new Error(`${label} is missing: ${pathname}`, { cause: error });
  });
  if (!details.isFile())
    throw new Error(`${label} is not a regular file: ${pathname}`);
  return details;
}

async function validateEnvironmentFile(envFile) {
  const details = await regularFile(envFile, "Relay environment file");
  const mode = details.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `Relay environment file mode must be 0600; found 0${mode.toString(8)}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    details.uid !== process.getuid()
  ) {
    throw new Error("Relay environment file must be owned by the current user");
  }
  const environment = parseRelayEnvironment(await readFile(envFile, "utf8"));
  const issues = validateRelayEnvironment(environment);
  if (issues.length > 0)
    throw new Error(`Relay environment is invalid: ${issues.join("; ")}`);
  return environment;
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${options.label ?? executable} could not run`, {
      cause: result.error,
    });
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`
    ).trim();
    throw new Error(
      `${options.label ?? executable} failed: ${detail.slice(0, 300)}`,
    );
  }
  return result;
}

async function findBun(explicitPath) {
  const candidate = explicitPath
    ? path.resolve(explicitPath)
    : runCommand("/usr/bin/which", ["bun"], {
        label: "Bun lookup",
      }).stdout.trim();
  if (!path.isAbsolute(candidate))
    throw new Error("Bun executable path must be absolute");
  await access(candidate, fsConstants.X_OK).catch((error) => {
    // error-policy:J2 identify the missing executable and preserve the filesystem cause.
    throw new Error(`Bun is not executable: ${candidate}`, { cause: error });
  });
  return candidate;
}

function launchDomain() {
  if (typeof process.getuid !== "function")
    throw new Error("Current user id is unavailable");
  return `gui/${process.getuid()}`;
}

function launchServiceTarget() {
  return `${launchDomain()}/${SERVICE_LABEL}`;
}

function launchctl(args, options = {}) {
  return runCommand("/bin/launchctl", args, {
    ...options,
    label: `launchctl ${args[0] ?? ""}`.trim(),
  });
}

async function writeFileStrict(pathname, contents, mode) {
  const handle = await open(pathname, "w", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(pathname, mode);
}

async function writeAtomic(pathname, contents, mode) {
  const temporary = `${pathname}.${process.pid}.tmp`;
  await writeFileStrict(temporary, contents, mode);
  await rename(temporary, pathname);
  await chmod(pathname, mode);
}

async function touchPrivate(pathname) {
  const handle = await open(pathname, "a", 0o600);
  await handle.close();
  await chmod(pathname, 0o600);
}

function sipStatus() {
  const result = runCommand("/usr/bin/csrutil", ["status"], {
    label: "csrutil status",
    allowFailure: true,
  });
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return {
    disabled: result.status === 0 && output.includes("disabled"),
    state: output.includes("disabled")
      ? "disabled"
      : output.includes("enabled")
        ? "enabled"
        : "unknown",
  };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    return {
      reachable: true,
      ok: response.ok,
      statusCode: response.status,
      body,
    };
  } catch (error) {
    // error-policy:J4 operator diagnostics expose a distinct unavailable state.
    return {
      reachable: false,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeRelaySummary(result) {
  if (!result.reachable) return { reachable: false, error: result.error };
  const body =
    result.body && typeof result.body === "object" ? result.body : {};
  return {
    reachable: true,
    httpOk: result.ok,
    statusCode: result.statusCode,
    status: typeof body.status === "string" ? body.status : "unknown",
    gatewayAuthMode:
      typeof body.gatewayAuthMode === "string"
        ? body.gatewayAuthMode
        : "unknown",
    outboundReady: body.outboundReadiness?.ready === true,
    pendingReplyCount:
      Number.isInteger(body.pendingReplyCount) && body.pendingReplyCount >= 0
        ? body.pendingReplyCount
        : null,
  };
}

async function serviceStatus(args) {
  const plistDetails = await stat(args.plist).catch((error) => {
    if (error?.code === "ENOENT") return null;
    // error-policy:J2 identify the inspected plist and preserve the filesystem cause.
    throw new Error(`Could not inspect LaunchAgent: ${args.plist}`, {
      cause: error,
    });
  });
  const loaded =
    launchctl(["print", launchServiceTarget()], { allowFailure: true })
      .status === 0;
  const health = await fetchJson(`http://127.0.0.1:${args.port}/health`);
  return {
    installed: Boolean(plistDetails?.isFile()),
    plistMode: plistDetails
      ? `0${(plistDetails.mode & 0o777).toString(8)}`
      : null,
    loaded,
    sip: sipStatus().state,
    relay: safeRelaySummary(health),
  };
}

async function install(args) {
  if (process.platform !== "darwin")
    throw new Error("BlueBubbles relay installation requires macOS");
  const bridgeScript = path.join(
    args.repoRoot,
    "packages",
    "cloud",
    "scripts",
    "bluebubbles-local-bridge.ts",
  );
  await regularFile(
    path.join(args.repoRoot, "package.json"),
    "Repository package manifest",
  );
  await regularFile(bridgeScript, "BlueBubbles relay script");
  const environment = await validateEnvironmentFile(args.envFile);
  const currentSip = sipStatus();
  if (!currentSip.disabled) {
    throw new Error(
      "SIP must report disabled before private-api relay installation",
    );
  }
  await regularFile(
    path.join(
      homedir(),
      "Library",
      "Application Support",
      "bluebubbles-server",
      "config.db",
    ),
    "BlueBubbles configuration database",
  );
  const bunPath = await findBun(args.bunPath);
  const localDirectory = path.join(args.repoRoot, ".eliza-local");
  const stdoutPath = path.join(localDirectory, "bluebubbles-bridge.stdout.log");
  const stderrPath = path.join(localDirectory, "bluebubbles-bridge.stderr.log");
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  await mkdir(path.dirname(args.plist), { recursive: true });
  await touchPrivate(stdoutPath);
  await touchPrivate(stderrPath);
  const plist = renderLaunchAgentPlist({
    repoRoot: args.repoRoot,
    envFile: args.envFile,
    bunPath,
    stdoutPath,
    stderrPath,
  });
  if (plist.includes(environment.BLUEBUBBLES_GATEWAY_TOKEN)) {
    throw new Error(
      "Refusing to write a LaunchAgent containing the gateway token",
    );
  }
  launchctl(["bootout", launchDomain(), args.plist], { allowFailure: true });
  await writeAtomic(args.plist, plist, 0o600);
  launchctl(["enable", launchServiceTarget()]);
  launchctl(["bootstrap", launchDomain(), args.plist]);
  launchctl(["kickstart", "-k", launchServiceTarget()]);
  return serviceStatus(args);
}

async function uninstall(args) {
  if (process.platform !== "darwin")
    throw new Error("BlueBubbles relay uninstallation requires macOS");
  launchctl(["bootout", launchDomain(), args.plist], { allowFailure: true });
  launchctl(["disable", launchServiceTarget()], { allowFailure: true });
  const removed = await unlink(args.plist)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      // error-policy:J2 identify the generated plist and preserve the filesystem cause.
      throw new Error(`Could not remove LaunchAgent: ${args.plist}`, {
        cause: error,
      });
    });
  return { removed, relayEnvironmentPreserved: true, logsPreserved: true };
}

async function doctor(args) {
  if (process.platform !== "darwin")
    throw new Error("BlueBubbles relay doctor requires macOS");
  const checks = [];
  try {
    await validateEnvironmentFile(args.envFile);
    checks.push({ name: "relay-environment", status: "pass" });
  } catch (error) {
    // error-policy:J4 operator diagnostics expose a distinct blocked check.
    checks.push({
      name: "relay-environment",
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const currentSip = sipStatus();
  checks.push({
    name: "sip-disabled",
    status: currentSip.disabled ? "pass" : "blocked",
    detail: currentSip.state,
  });
  const status = await serviceStatus(args);
  checks.push({
    name: "launch-agent",
    status: status.loaded ? "pass" : "blocked",
  });
  checks.push({
    name: "registered-device-auth",
    status:
      status.relay.gatewayAuthMode === "registered-device" ? "pass" : "blocked",
  });
  checks.push({
    name: "private-api-outbound",
    status: status.relay.outboundReady === true ? "pass" : "blocked",
  });
  checks.push({
    name: "pending-replies",
    status: status.relay.pendingReplyCount === 0 ? "pass" : "blocked",
  });
  const relayDoctor = await fetchJson(`http://127.0.0.1:${args.port}/doctor`);
  if (relayDoctor.reachable && Array.isArray(relayDoctor.body?.checks)) {
    for (const check of relayDoctor.body.checks) {
      if (typeof check?.name !== "string" || typeof check?.status !== "string")
        continue;
      checks.push({ name: `relay:${check.name}`, status: check.status });
    }
  } else {
    checks.push({ name: "relay-doctor", status: "blocked" });
  }
  return {
    ready: checks.every((check) => check.status === "pass"),
    checks,
    status,
  };
}

function output(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    process.stdout.write(
      `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`,
    );
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (process.platform !== "darwin") {
    throw new Error("BlueBubbles relay lifecycle commands require macOS");
  }
  const result =
    args.command === "install"
      ? await install(args)
      : args.command === "uninstall"
        ? await uninstall(args)
        : args.command === "doctor"
          ? await doctor(args)
          : await serviceStatus(args);
  output(result, args.json);
  if (args.command === "doctor" && result.ready !== true) return 1;
  return 0;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // error-policy:J1 the CLI boundary renders one actionable, secret-free failure.
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
