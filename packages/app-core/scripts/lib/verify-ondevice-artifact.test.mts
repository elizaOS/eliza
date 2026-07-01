import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeRendererBuildManifest } from "./renderer-build-manifest.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";
import { verifyStagedArtifact } from "./verify-ondevice-artifact.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath: string) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-artifact-"));
});

afterEach(() => {
  removePathRecursive(tmp);
});

function makeDist(dir: string, asset = "index-abc.js") {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, "assets", asset), "x");
}

describe("verifyStagedArtifact", () => {
  it("passes when staged renderer matches the build and required files exist", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    writeRendererBuildManifest(dist);
    fs.cpSync(dist, staged, { recursive: true });
    fs.mkdirSync(path.join(staged, "agent"), { recursive: true });
    fs.writeFileSync(path.join(staged, "agent", "agent-bundle.js"), "AGENT");

    const result = verifyStagedArtifact({
      rendererDir: staged,
      freshDistDir: dist,
      requiredFiles: ["agent/agent-bundle.js"],
      label: "ios",
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.manifest?.buildId).toBeTruthy();
  });

  it("fails when the staged renderer is stale vs the build", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(staged, "index-old.js");
    writeRendererBuildManifest(staged);
    makeDist(dist, "index-new.js");
    writeRendererBuildManifest(dist);

    const result = verifyStagedArtifact({
      rendererDir: staged,
      freshDistDir: dist,
      label: "ios",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/STALE RENDERER/);
  });

  it("fails when a required companion file (agent bundle / native lib) is missing", () => {
    const dist = path.join(tmp, "dist");
    const staged = path.join(tmp, "public");
    makeDist(dist);
    writeRendererBuildManifest(dist);
    fs.cpSync(dist, staged, { recursive: true });

    const result = verifyStagedArtifact({
      rendererDir: staged,
      freshDistDir: dist,
      requiredFiles: ["agent/agent-bundle.js"],
      label: "ios",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /missing required artifact file/,
    );
  });

  it("verifies presence-only when no fresh dist is supplied", () => {
    const staged = path.join(tmp, "public");
    makeDist(staged);
    writeRendererBuildManifest(staged);
    const result = verifyStagedArtifact({ rendererDir: staged });
    expect(result.ok).toBe(true);
    expect(result.manifest?.buildId).toBeTruthy();
  });

  it("fails presence-only when the staged renderer has no build stamp", () => {
    const staged = path.join(tmp, "public");
    makeDist(staged);
    const result = verifyStagedArtifact({ rendererDir: staged });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/no renderer build stamp/);
  });
});
