import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import tmp from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  main,
  parseArgs,
  pluginHasHeroAsset,
  runCli,
  scanAppPluginDirs,
} from "./generate-view-heroes.mjs";

describe("generate-view-heroes CLI option parsing", () => {
  it("defaults to standard configuration", () => {
    const options = parseArgs([]);
    assert.equal(options.dryRun, false);
    assert.equal(options.check, false);
    assert.equal(options.help, false);
    assert.ok(
      typeof options.repoRoot === "string" && options.repoRoot.length > 0,
    );
  });

  it("parses --help and -h flags", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });

  it("parses --dry-run and --check flags", () => {
    assert.equal(parseArgs(["--dry-run"]).dryRun, true);
    assert.equal(parseArgs(["--check"]).check, true);
  });

  it("parses --repo-root=<dir> and --repo-root <dir>", () => {
    const opts1 = parseArgs(["--repo-root=/tmp/test-repo"]);
    assert.equal(opts1.repoRoot, path.resolve("/tmp/test-repo"));

    const opts2 = parseArgs(["--repo-root", "/tmp/test-repo"]);
    assert.equal(opts2.repoRoot, path.resolve("/tmp/test-repo"));
  });

  it("rejects --repo-root without a value", () => {
    assert.throws(
      () => parseArgs(["--repo-root"]),
      /\[generate-view-heroes\] --repo-root requires a directory path/,
    );
    assert.throws(
      () => parseArgs(["--repo-root="]),
      /\[generate-view-heroes\] --repo-root requires a directory path/,
    );
  });

  it("rejects unknown options", () => {
    assert.throws(
      () => parseArgs(["--invalid-flag"]),
      /\[generate-view-heroes\] Unknown option: --invalid-flag/,
    );
  });
});

describe("generate-view-heroes app plugin scan and hero detection", () => {
  it("scans app plugins and detects hero assets accurately", () => {
    const mockRoot = path.join(tmp.tmpdir(), `test-heroes-${Date.now()}`);
    mkdirSync(path.join(mockRoot, "plugins", "plugin-a", "assets"), {
      recursive: true,
    });
    mkdirSync(path.join(mockRoot, "plugins", "plugin-b"), { recursive: true });

    writeFileSync(
      path.join(mockRoot, "plugins", "plugin-a", "package.json"),
      JSON.stringify({ elizaos: { app: { displayName: "App A" } } }),
    );
    writeFileSync(
      path.join(mockRoot, "plugins", "plugin-b", "package.json"),
      JSON.stringify({ elizaos: { app: { displayName: "App B" } } }),
    );
    writeFileSync(
      path.join(mockRoot, "plugins", "plugin-a", "assets", "hero.svg"),
      "<svg></svg>",
    );

    try {
      const appDirs = scanAppPluginDirs(mockRoot);
      assert.deepEqual(appDirs, ["plugin-a", "plugin-b"]);

      assert.equal(pluginHasHeroAsset("plugin-a", mockRoot), true);
      assert.equal(pluginHasHeroAsset("plugin-b", mockRoot), false);
    } finally {
      rmSync(mockRoot, { recursive: true, force: true });
    }
  });
});

describe("generate-view-heroes execution", () => {
  it("runCli returns 0 for --help", async () => {
    const code = await runCli(["--help"]);
    assert.equal(code, 0);
  });

  it("main returns help result when --help flag is set", async () => {
    const result = await main(["--help"]);
    assert.equal(result.help, true);
    assert.equal(result.writtenCount, 0);
  });

  it("main supports --dry-run mode", async () => {
    const result = await main(["--dry-run"]);
    assert.ok(result.writtenCount > 0);
    assert.equal(result.missingCount, 0);
  });
});
