/**
 * Covers the dedicated-Mac relay installer with deterministic environment and
 * plist fixtures; no launchd service, BlueBubbles process, or secret is used.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArguments,
  parseRelayEnvironment,
  renderLaunchAgentPlist,
  validateRelayEnvironment,
} from "./install-bluebubbles-relay.mjs";

const validEnvironment = {
  ELIZA_CLOUD_BLUEBUBBLES_URL:
    "https://api.elizacloud.ai/api/webhooks/bluebubbles/bb-12345678",
  BLUEBUBBLES_BRIDGE_ID: "bb-12345678",
  BLUEBUBBLES_GATEWAY_TOKEN: `bbg_${"a".repeat(64)}`,
  BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14155550123",
  BLUEBUBBLES_SEND_METHOD: "private-api",
  BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED: "false",
  BLUEBUBBLES_PENDING_RETRY_ENABLED: "false",
};

test("parses only inert KEY=VALUE environment assignments", () => {
  const source = Object.entries(validEnvironment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  assert.deepEqual(parseRelayEnvironment(source), validEnvironment);
  assert.throws(
    () =>
      parseRelayEnvironment(
        "BLUEBUBBLES_GATEWAY_TOKEN=$(security find-generic-password)",
      ),
    /shell syntax/,
  );
  assert.throws(
    () => parseRelayEnvironment('BLUEBUBBLES_GATEWAY_TOKEN="$(whoami)"'),
    /shell expansion/,
  );
  assert.throws(
    () => parseRelayEnvironment("source ~/.profile"),
    /KEY=VALUE assignment/,
  );
});

test("requires registered-device private-api fail-closed settings", () => {
  assert.deepEqual(validateRelayEnvironment(validEnvironment), []);
  const issues = validateRelayEnvironment({
    ...validEnvironment,
    BLUEBUBBLES_SEND_METHOD: "apple-script",
    BLUEBUBBLES_LOOPBACK_NORMALIZATION_ENABLED: "true",
    BLUEBUBBLES_PENDING_RETRY_ENABLED: "true",
    BLUEBUBBLES_GATEWAY_SECRET: "legacy-secret",
  });
  assert.match(issues.join("\n"), /registered-device/);
  assert.match(issues.join("\n"), /private-api/);
  assert.match(
    issues.join("\n"),
    /LOOPBACK_NORMALIZATION_ENABLED must be false/,
  );
  assert.match(issues.join("\n"), /PENDING_RETRY_ENABLED must be false/);
});

test("renders an absolute-path LaunchAgent without credentials", () => {
  const plist = renderLaunchAgentPlist({
    repoRoot: "/opt/eliza & relay",
    envFile: "/opt/eliza & relay/.eliza-local/bluebubbles-bridge.env",
    bunPath: "/opt/bun/bin/bun",
    stdoutPath: "/opt/eliza & relay/.eliza-local/stdout.log",
    stderrPath: "/opt/eliza & relay/.eliza-local/stderr.log",
  });
  assert.match(plist, /ai\.elizacloud\.bluebubbles-bridge/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /source/);
  assert.match(plist, /&amp;/);
  assert.doesNotMatch(plist, /bbg_[a-f0-9]{64}/);
});

test("parses lifecycle commands and rejects invalid ports", () => {
  assert.equal(
    parseArguments(["doctor", "--json"], {
      repoRoot: "/repo",
      envFile: "/repo/env",
      plist: "/tmp/relay.plist",
    }).command,
    "doctor",
  );
  assert.throws(
    () => parseArguments(["status", "--port", "0"]),
    /between 1 and 65535/,
  );
  assert.equal(
    parseArguments(["status", "--repo-root", "/srv/eliza"]).envFile,
    "/srv/eliza/.eliza-local/bluebubbles-bridge.env",
  );
  assert.throws(() => parseArguments(["start"]), /Unknown argument/);
});
