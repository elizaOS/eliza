/**
 * Guards the first canonical store-distribution leg: exact release identity,
 * protected publication, registered Snap name, and fail-closed credentials.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const releaseSource = readFileSync(
  new URL(".github/workflows/release.yaml", repoRoot),
  "utf8",
);
const snapSource = readFileSync(
  new URL(".github/workflows/snap-publish.yml", repoRoot),
  "utf8",
);
const snapcraftSource = readFileSync(
  new URL("packages/app-core/packaging/snap/snapcraft.yaml", repoRoot),
  "utf8",
);
const mobileSource = readFileSync(
  new URL(".github/workflows/store-mobile-publish.yml", repoRoot),
  "utf8",
);
const windowsSource = readFileSync(
  new URL(".github/workflows/store-windows-publish.yml", repoRoot),
  "utf8",
);

describe("canonical store release workflow", () => {
  test("calls Snap only after exact release finalization", () => {
    const workflow = Bun.YAML.parse(releaseSource) as {
      jobs?: Record<
        string,
        {
          needs?: string | string[];
          uses?: string;
          with?: Record<string, string>;
          secrets?: string;
        }
      >;
    };
    const snap = workflow.jobs?.["publish-snap"];
    expect(snap?.needs).toBe("finalize");
    expect(snap?.uses).toBe("./.github/workflows/snap-publish.yml");
    expect(snap?.with?.source_sha).toContain(
      "needs.finalize.outputs.source_sha",
    );
    expect(snap?.with?.version).toContain("needs.finalize.outputs.version");
    expect(snap?.secrets).toBe("inherit");
  });

  test("keeps Snap callable-only, protected, exact-tag-bound, and fail-closed", () => {
    const workflow = Bun.YAML.parse(snapSource) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, { environment?: { name?: string } }>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    expect(workflow.jobs?.["build-and-publish"]?.environment?.name).toBe(
      "production-release",
    );
    expect(snapSource).toContain(`ref: \${{ inputs.source_sha }}`);
    expect(snapSource).toContain("refs/tags/$EXPECTED_TAG^{commit}");
    expect(snapSource).toContain(
      "SNAPCRAFT_STORE_CREDENTIALS is required for the canonical store release",
    );
    expect(snapSource).toContain("snapcraft whoami");
    expect(snapSource).toContain(
      'snapcraft upload "$SNAP_FILE" --release "$CHANNEL"',
    );
  });

  test("publishes the registered stable-grade snap identity", () => {
    expect(snapcraftSource).toMatch(/^name: eliza$/m);
    expect(snapcraftSource).toMatch(/^title: Eliza$/m);
    expect(snapcraftSource).toMatch(/^grade: stable$/m);
    expect(snapcraftSource).toMatch(/^ {2}eliza:$/m);
  });

  test("calls mobile stores only after exact release finalization", () => {
    const workflow = Bun.YAML.parse(releaseSource) as {
      jobs?: Record<
        string,
        {
          needs?: string;
          uses?: string;
          with?: Record<string, string>;
          secrets?: string;
        }
      >;
    };
    const mobile = workflow.jobs?.["publish-mobile-stores"];
    expect(mobile?.needs).toBe("finalize");
    expect(mobile?.uses).toBe("./.github/workflows/store-mobile-publish.yml");
    expect(mobile?.with?.source_sha).toContain(
      "needs.finalize.outputs.source_sha",
    );
    expect(mobile?.with?.version).toContain("needs.finalize.outputs.version");
    expect(mobile?.secrets).toBe("inherit");
  });

  test("keeps mobile stores callable-only, protected, exact-bound, and fail-closed", () => {
    const workflow = Bun.YAML.parse(mobileSource) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, { environment?: { name?: string } }>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    expect(workflow.jobs?.android?.environment?.name).toBe(
      "production-release",
    );
    expect(workflow.jobs?.ios?.environment?.name).toBe("production-release");
    expect(mobileSource).toContain(`ref: \${{ inputs.source_sha }}`);
    expect(mobileSource).toContain("refs/tags/$EXPECTED_TAG^{commit}");
    expect(mobileSource).toContain(
      "Missing required Google Play release secrets",
    );
    expect(mobileSource).toContain("Missing required Apple release secrets");
    expect(mobileSource).toContain("bun run build:android:cloud");
    expect(mobileSource).toContain('bundle exec fastlane "$APPLE_LANE"');
  });

  test("provisions every shipping iOS extension from the generated project", () => {
    expect(mobileSource).toContain("PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);");
    expect(mobileSource).toContain('index($0, app ".") == 1');
    expect(mobileSource).toContain("$0 !~ /\\.AppUITests$/");
    expect(mobileSource).toContain(
      'echo "APP_IDENTIFIER_EXTRA=$extension_ids" >> "$GITHUB_ENV"',
    );
    expect(mobileSource).not.toContain(
      "APP_IDENTIFIER_EXTRA=$app_id.WebsiteBlockerContentExtension",
    );
  });

  test("calls Microsoft Store only after exact release finalization", () => {
    const workflow = Bun.YAML.parse(releaseSource) as {
      jobs?: Record<
        string,
        {
          needs?: string;
          uses?: string;
          with?: Record<string, string>;
          secrets?: string;
        }
      >;
    };
    const windows = workflow.jobs?.["publish-microsoft-store"];
    expect(windows?.needs).toBe("finalize");
    expect(windows?.uses).toBe("./.github/workflows/store-windows-publish.yml");
    expect(windows?.with?.source_sha).toContain(
      "needs.finalize.outputs.source_sha",
    );
    expect(windows?.with?.version).toContain("needs.finalize.outputs.version");
    expect(windows?.secrets).toBe("inherit");
  });

  test("keeps Microsoft Store callable-only, protected, stable-only, and fail-closed", () => {
    const workflow = Bun.YAML.parse(windowsSource) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, { environment?: { name?: string }; if?: string }>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    const publish = workflow.jobs?.["build-and-publish"];
    expect(publish?.environment?.name).toBe("production-release");
    expect(publish?.if).toContain("inputs.channel == 'latest'");
    expect(windowsSource).toContain(`ref: \${{ inputs.source_sha }}`);
    expect(windowsSource).toContain("refs/tags/$EXPECTED_TAG^{commit}");
    expect(windowsSource).toContain(
      "Missing required Microsoft Store release configuration",
    );
    expect(windowsSource).toContain("ELIZA_BUILD_VARIANT: store");
    expect(windowsSource).toContain(
      "runFullTrust|windows.fullTrustApplication",
    );
    expect(windowsSource).toContain("microsoft-store-submission.mjs");
  });
});
