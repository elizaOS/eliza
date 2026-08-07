/**
 * Real-path tests for clawd-plugin ↔ clawd-code resolution (no mocks of the sibling tree).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CLAWD_CODE_GITHUB,
  CLAWD_CODE_ROOT,
  CLAWD_PLUGIN_ROOT,
  formatResolution,
  resolveCheshireBridgePaths,
  resolveClawdCode,
  resolveClawdPluginDir,
} from "./resolve-clawd-code.mjs";

describe("clawd-plugin ↔ clawd-code bridge", () => {
  it("points at Solizardking/clawd-code submodule root", () => {
    assert.equal(CLAWD_CODE_GITHUB, "https://github.com/Solizardking/clawd-code");
    assert.ok(existsSync(join(CLAWD_CODE_ROOT, "package.json")));
    const pkg = JSON.parse(
      readFileSync(join(CLAWD_CODE_ROOT, "package.json"), "utf8"),
    );
    assert.equal(pkg.name, "@solana-clawd/clawd-code");
    assert.match(pkg.repository?.url ?? "", /Solizardking\/clawd-code/);
  });

  it("resolves a runnable clawd-code entry (sibling dist/src preferred)", () => {
    const res = resolveClawdCode();
    assert.ok(["bin", "node", "tsx", "npx"].includes(res.kind));
    assert.ok(res.command);
    assert.ok(Array.isArray(res.args));
    if (res.kind === "node" || res.kind === "tsx") {
      assert.ok(res.path && existsSync(res.path), `missing ${res.path}`);
      assert.ok(String(res.path).includes("clawd-code"));
    }
  });

  it("resolves monorepo plugin dir for --plugin-dir", () => {
    const dir = resolveClawdPluginDir();
    assert.equal(dir, CLAWD_PLUGIN_ROOT);
    assert.ok(existsSync(join(dir, ".mcp.json")));
    assert.ok(existsSync(join(dir, "skills", "clawd-code", "SKILL.md")));
  });

  it("exposes Cheshire monorepo bridge paths", () => {
    const paths = resolveCheshireBridgePaths();
    assert.equal(paths.clawdCodeGithub, CLAWD_CODE_GITHUB);
    assert.ok(existsSync(join(paths.cheshireEliza, "package.json")));
    assert.ok(existsSync(join(paths.pluginCheshireMemory, "package.json")));
    assert.ok(existsSync(join(paths.pluginClawdBrowser, "package.json")));
  });

  it("formatResolution includes github + pluginDir", () => {
    const fmt = formatResolution();
    assert.equal(fmt.github, CLAWD_CODE_GITHUB);
    assert.ok(fmt.pluginDir.includes("clawd-plugin"));
  });
});
