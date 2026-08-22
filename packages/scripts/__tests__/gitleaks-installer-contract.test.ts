/**
 * Verifies every workflow that installs gitleaks goes through the shared
 * checksum-pinned installer (.github/scripts/install-gitleaks.sh) and that the
 * installer pins a SHA256 per supported host. Static contract plus a shell
 * syntax check — no network download.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const installerPath = path.join(
  repoRoot,
  ".github/scripts/install-gitleaks.sh",
);
const installerSource = fs.readFileSync(installerPath, "utf8");

const GITLEAKS_VERSION = "8.30.1";
// linux_x64 hash from the upstream gitleaks_8.30.1_checksums.txt release asset.
const GITLEAKS_LINUX_X64_SHA256 =
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";

const CONSUMING_WORKFLOWS = [
  "ci.yml",
  "gitleaks.yml",
  "pr-static-smoke.yml",
  "test.yml",
] as const;

function workflowSource(name: string): string {
  return fs.readFileSync(
    path.join(repoRoot, ".github/workflows", name),
    "utf8",
  );
}

describe("gitleaks installer supply-chain contract", () => {
  test("every gitleaks consumer installs through the shared pinned script", () => {
    for (const name of CONSUMING_WORKFLOWS) {
      const source = workflowSource(name);
      expect(source).toContain("install-gitleaks.sh");
      // No consumer may carry its own unpinned download of the release asset.
      expect(source).not.toContain("gitleaks/releases/download");
    }
  });

  test("the installer pins the version and verifies SHA256 before extracting", () => {
    expect(installerSource).toContain(`GITLEAKS_VERSION="${GITLEAKS_VERSION}"`);
    expect(installerSource).toContain(GITLEAKS_LINUX_X64_SHA256);
    // Fail closed on mismatch, and never extract an unverified archive.
    expect(installerSource).toContain("checksum mismatch");
    expect(installerSource.indexOf("checksum mismatch")).toBeLessThan(
      installerSource.indexOf("tar -xzf"),
    );
    // Every supported host spelling carries a pinned hash.
    for (const host of [
      "Linux-x86_64",
      "Linux-aarch64|Linux-arm64",
      "Darwin-x86_64",
      "Darwin-arm64",
    ]) {
      expect(installerSource).toContain(host);
    }
    const pinnedHashes = installerSource.match(/gitleaks_sha="[0-9a-f]{64}"/g);
    expect(pinnedHashes).toHaveLength(4);
  });

  test("the installer parses as valid bash", () => {
    const result = spawnSync("bash", ["-n", installerPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
