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
  test("release contract checkout includes the pull-request base history", () => {
    const source = readFileSync(
      join(workflowDirectory, "electrobun-contract.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<
        string,
        {
          steps?: Array<{
            name?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const checkout = workflow.jobs?.["release-contract"]?.steps?.find(
      (step) => step.name === "Checkout",
    );

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("has one manually dispatched release workflow", () => {
    const workflowFiles = readdirSync(workflowDirectory).filter((name) =>
      /\.ya?ml$/.test(name),
    );
    // readdir order is platform-unspecified (macOS APFS returns insertion
    // order), so pin the set through a sort rather than the directory walk.
    const releaseEntries = workflowFiles
      .filter((name) =>
        /^(?:release|publish|update-homebrew|.*-release)\.(?:yml|yaml)$/.test(
          name,
        ),
      )
      .sort();
    expect(releaseEntries).toEqual(["cloud-cf-release.yml", "release.yaml"]);

    // `cloud-cf-release.yml` shares the name but not the authority: it is the
    // reusable Cloudflare deployment leg of `cloud-cf-deploy.yml`. It must stay
    // callable only by that workflow and must never publish packages, or the
    // repository would have a second release entry point.
    const cloudRelease = readFileSync(
      join(workflowDirectory, "cloud-cf-release.yml"),
      "utf8",
    );
    const cloudReleaseWorkflow = Bun.YAML.parse(cloudRelease) as {
      on?: Record<string, unknown>;
    };
    expect(Object.keys(cloudReleaseWorkflow.on ?? {})).toEqual([
      "workflow_call",
    ]);
    for (const publication of [
      "npm publish",
      "bun publish",
      "npm dist-tag",
      "registry.npmjs.org",
      "release-candidate",
      "NPM_TOKEN",
    ]) {
      expect(cloudRelease).not.toContain(publication);
    }

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
      "update-homebrew.yml",
      "windows-store-release.yml",
    ]) {
      expect(existsSync(join(workflowDirectory, name))).toBe(false);
    }
  });
});
