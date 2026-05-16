import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findUnsafeNetworkPolicyFindings,
  isUnsafeAllowNavigationEntry,
  isUnsafeNetworkUrlLiteral,
} from "./verify-ios-app-store.mjs";
import {
  findForbiddenRuntimeImportGroups,
  findForbiddenRuntimeStrings,
} from "./ios-app-store-runtime-policy.mjs";

function makeAppFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-policy-"));
  const app = path.join(root, "Eliza.app");
  fs.mkdirSync(app, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(app, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return app;
}

test("flags loopback and private cleartext URL literals", () => {
  assert.equal(
    isUnsafeNetworkUrlLiteral("http://127.0.0.1:31337/api/health"),
    true,
  );
  assert.equal(isUnsafeNetworkUrlLiteral("ws://192.168.1.10/api/events"), true);
  assert.equal(isUnsafeNetworkUrlLiteral("https://www.elizacloud.ai"), false);
  assert.equal(isUnsafeNetworkUrlLiteral("wss://api.elizacloud.ai/ws"), false);
});

test("flags loopback and private Capacitor allowNavigation hosts", () => {
  assert.equal(isUnsafeAllowNavigationEntry("localhost"), true);
  assert.equal(isUnsafeAllowNavigationEntry("*.local"), true);
  assert.equal(isUnsafeAllowNavigationEntry("10.0.0.5"), true);
  assert.equal(isUnsafeAllowNavigationEntry("*.elizacloud.ai"), false);
});

test("finds unsafe network policy in app html and capacitor config", () => {
  const app = makeAppFixture({
    "index.html": `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' ws://127.0.0.1:* http://192.168.1.2:* https://*">`,
    "capacitor.config.json": JSON.stringify({
      server: {
        allowNavigation: ["*.elizacloud.ai", "localhost", "10.0.0.5"],
      },
    }),
  });

  const findings = findUnsafeNetworkPolicyFindings(app);

  assert.equal(findings.length, 4);
  assert.deepEqual(findings.map((finding) => finding.reason).sort(), [
    "loopback/private allowNavigation host",
    "loopback/private allowNavigation host",
    "loopback/private cleartext URL",
    "loopback/private cleartext URL",
  ]);
});

test("accepts HTTPS/WSS-only app policy", () => {
  const app = makeAppFixture({
    "index.html": `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' eliza-local-agent: https://* wss://*">`,
    "capacitor.config.json": JSON.stringify({
      server: {
        allowNavigation: ["*.elizacloud.ai", "app.eliza.how"],
      },
    }),
  });

  assert.deepEqual(findUnsafeNetworkPolicyFindings(app), []);
});

test("groups App Store-forbidden runtime imports without substring false positives", () => {
  const groups = findForbiddenRuntimeImportGroups(`
                 U _dlopen
                 U _dlsym
                 U _posix_spawn
                 U _posix_spawn_file_actions_adddup2
                 U _fork
                 U _execve
                 U _forkpty
                 U _not_dlopen
  `);

  assert.deepEqual(
    groups.map((group) => [group.label, group.symbols]),
    [
      ["dynamic loader / native extension loading", ["_dlopen", "_dlsym"]],
      [
        "process spawning / helper executables",
        [
          "_execve",
          "_fork",
          "_posix_spawn",
          "_posix_spawn_file_actions_adddup2",
        ],
      ],
    ],
  );
});

test("flags executable-memory runtime string markers", () => {
  assert.deepEqual(findForbiddenRuntimeStrings("uses MAP_JIT when enabled"), [
    "\\bMAP_JIT\\b",
  ]);
});
