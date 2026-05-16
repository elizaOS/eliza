import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("release workflow drift", () => {
  it("keeps release readiness wired to generated metadata and release:check", () => {
    const workflow = readRepoFile(".github/workflows/release-electrobun.yml");

    expect(workflow).toContain("name: Release readiness checks");
    expect(workflow).toContain(
      "ELIZA_RELEASE_TAG: $" + "{{ needs.prepare.outputs.tag }}",
    );
    expect(workflow).toContain('ELIZA_VALIDATE_CDN: "1"');
    expect(workflow).toContain(
      "node packages/app-core/scripts/write-homepage-release-data.mjs",
    );
    expect(workflow).toContain(
      "node packages/app-core/scripts/generate-static-asset-manifest.mjs",
    );
    expect(workflow).toContain("bun run release:check");
  });

  it("keeps release contract validation on Electrobun pull requests", () => {
    const workflow = readRepoFile(
      ".github/workflows/test-electrobun-release.yml",
    );

    expect(workflow).toContain("bun run test:release:contract");
    expect(workflow).not.toContain(
      "uses: ./.github/workflows/release-electrobun.yml",
    );
  });

  it("keeps release-only mobile builders manually dispatched", () => {
    const androidWorkflow = readRepoFile(".github/workflows/build-android.yml");
    const iosWorkflow = readRepoFile(".github/workflows/build-ios.yml");

    expect(androidWorkflow).toContain("workflow_dispatch:");
    expect(iosWorkflow).toContain("workflow_dispatch:");
    expect(androidWorkflow).not.toContain("types: [created]");
    expect(iosWorkflow).not.toContain("types: [created]");
  });

  it("keeps Android Play release using the cloud Android build", () => {
    const workflow = readRepoFile(".github/workflows/android-release.yml");

    expect(workflow).toContain("bun run build:android:cloud");
  });
});
