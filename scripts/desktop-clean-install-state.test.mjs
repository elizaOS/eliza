/**
 * Verifies the desktop clean-install script's pure decision logic: argument
 * parsing boundaries, state-location resolution (env precedence), and bundle
 * discovery filtering. Deterministic — no Keychain or filesystem mutation.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ELIZA_KEYCHAIN_SERVICES,
  elizaStateLocations,
  installedElizaBundles,
  parseCleanArgs,
} from "./desktop-clean-install-state.mjs";

describe("parseCleanArgs", () => {
  it("defaults to a dry run keeping bundles", () => {
    const args = parseCleanArgs([]);
    assert.equal(args.apply, false);
    assert.equal(args.keepKeychain, false);
    assert.equal(args.keepFiles, false);
    assert.equal(args.keepBundles, true);
  });

  it("parses every supported flag", () => {
    const args = parseCleanArgs([
      "--apply",
      "--keep-keychain",
      "--keep-files",
      "--delete-bundles",
    ]);
    assert.equal(args.apply, true);
    assert.equal(args.keepKeychain, true);
    assert.equal(args.keepFiles, true);
    assert.equal(args.keepBundles, false);
  });

  it("rejects unknown arguments instead of silently ignoring them", () => {
    assert.throws(() => parseCleanArgs(["--nuke"]), /Unknown argument/);
  });
});

describe("elizaStateLocations", () => {
  it("honors ELIZA_STATE_DIR over the XDG default", () => {
    const locations = elizaStateLocations({
      home: "/Users/example",
      env: { ELIZA_STATE_DIR: "/custom/state" },
    });
    assert.ok(locations.includes("/custom/state"));
    assert.ok(!locations.some((l) => l.endsWith(".local/state/eliza")));
  });

  it("falls back to XDG state home with the namespace", () => {
    const locations = elizaStateLocations({
      home: "/Users/example",
      env: {},
    });
    assert.ok(locations.includes("/Users/example/.local/state/eliza"));
  });

  it("covers the Keychain-adjacent filesystem surfaces that a naive wipe misses", () => {
    const locations = elizaStateLocations({ home: "/Users/example", env: {} });
    for (const suffix of [
      "Library/Application Support/ai.elizaos.app",
      "Library/WebKit/ai.elizaos.app",
      "Library/HTTPStorages/ai.elizaos.app",
      "Library/Preferences/ai.elizaos.app.plist",
    ]) {
      assert.ok(
        locations.some((l) => l.endsWith(suffix)),
        `expected a location ending in ${suffix}`,
      );
    }
  });
});

describe("installedElizaBundles", () => {
  it("matches only Eliza*.app names in the user Applications dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "clean-test-"));
    const apps = path.join(home, "Applications");
    fs.mkdirSync(apps);
    for (const name of [
      "Eliza.app",
      "Eliza-canary.app",
      "NotEliza.app",
      "Elizax",
    ]) {
      fs.mkdirSync(path.join(apps, name));
    }
    try {
      const bundles = installedElizaBundles({ home }).filter((b) =>
        b.startsWith(apps),
      );
      const names = bundles.map((b) => path.basename(b)).sort();
      assert.deepEqual(names, ["Eliza-canary.app", "Eliza.app"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ELIZA_KEYCHAIN_SERVICES", () => {
  it("pins both services the desktop stack writes", () => {
    assert.deepEqual([...ELIZA_KEYCHAIN_SERVICES].sort(), [
      "ai.elizaos.agent.vault",
      "eliza",
    ]);
  });
});
