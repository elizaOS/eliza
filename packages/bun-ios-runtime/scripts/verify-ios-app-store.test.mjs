import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  describeXcframeworkLibrariesFromInfo,
  findUnsafeNetworkPolicyFindings,
  isUnsafeAllowNavigationEntry,
  isUnsafeNetworkUrlLiteral,
  missingRequiredSlicesFromInfo,
  parseRequiredSlices,
  xcframeworkLibrarySlice,
} from "./verify-ios-app-store.mjs";

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

test("classifies and requires device/simulator xcframework slices", () => {
  const info = {
    AvailableLibraries: [
      {
        LibraryIdentifier: "ios-arm64",
        SupportedPlatform: "ios",
      },
      {
        LibraryIdentifier: "ios-arm64-simulator",
        SupportedPlatform: "ios",
        SupportedPlatformVariant: "simulator",
      },
    ],
  };

  assert.equal(xcframeworkLibrarySlice(info.AvailableLibraries[0]), "device");
  assert.equal(
    xcframeworkLibrarySlice(info.AvailableLibraries[1]),
    "simulator",
  );
  assert.deepEqual(missingRequiredSlicesFromInfo(info, ["device"]), []);
  assert.deepEqual(missingRequiredSlicesFromInfo(info, ["simulator"]), []);
  assert.equal(
    describeXcframeworkLibrariesFromInfo(info),
    "ios/ios-arm64, ios-simulator/ios-arm64-simulator",
  );
});

test("reports missing required device xcframework slice", () => {
  const info = {
    AvailableLibraries: [
      {
        LibraryIdentifier: "ios-arm64-simulator",
        SupportedPlatform: "ios",
        SupportedPlatformVariant: "simulator",
      },
    ],
  };

  assert.deepEqual(missingRequiredSlicesFromInfo(info, ["device"]), ["device"]);
  assert.deepEqual(parseRequiredSlices("all"), ["device", "simulator"]);
  assert.deepEqual(parseRequiredSlices("device, simulator,device"), [
    "device",
    "simulator",
  ]);
});
