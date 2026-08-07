/**
 * Guards the repository's single explicit release entry point without
 * dispatching publication or requiring credentials.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowDirectory = join(repoRoot, ".github", "workflows");

describe("release workflow authority", () => {
  test("has one manually dispatched release workflow", () => {
    const workflowFiles = readdirSync(workflowDirectory).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    const releaseEntries = workflowFiles.filter((name) =>
      /^(?:release|publish|update-homebrew|.*-release)\.(?:yml|yaml)$/.test(
        name,
      ),
    );
    expect(releaseEntries).toEqual(["release.yaml"]);

    const source = readFileSync(
      join(workflowDirectory, "release.yaml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      on?: Record<string, unknown>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(source).not.toMatch(/^\s+(?:push|release|schedule):/m);
  });

  test("retired competing release authorities stay absent", () => {
    for (const name of [
      "release-orchestrator.yml",
      "publish-packages.yml",
      "android-release.yml",
      "apple-store-release.yml",
      "release-electrobun.yml",
      "update-homebrew.yml",
      "snap-publish.yml",
      "windows-store-release.yml",
    ]) {
      expect(existsSync(join(workflowDirectory, name))).toBe(false);
    }
  });
});
