/**
 * Reader + pre-release predicate for eliza-1 GGUF bundles.
 *
 * Uses tmpdir-backed synthetic bundles so the test never touches the user's
 * real `~/.eliza/local-inference/models/` checkout.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bundleIsPreRelease,
  type ElizaOneBundleManifest,
  type ElizaOneReleaseState,
  readElizaOneBundle,
} from "../eliza-1-bundle.ts";

interface ManifestOverrides {
  bundleId?: string;
  modelSize?: string;
  releaseState?: ElizaOneReleaseState | string;
  publishEligible?: boolean;
  final?: { weights: boolean };
  weightsPath?: string;
  draftersPath?: string;
  sha256?: string;
  omit?: string[];
}

function makeBundle(overrides: ManifestOverrides = {}): {
  bundlePath: string;
  weightsPath: string;
  draftersPath: string;
} {
<<<<<<< HEAD
  const root = mkdtempSync(path.join(tmpdir(), "eliza-1-bundle-test-"));
  const bundlePath = path.join(root, "eliza-1-0.6b.bundle");
  mkdirSync(bundlePath, { recursive: true });
  const weightsName = "weights.gguf";
  const draftersName = "drafter.gguf";
  const weightsPath = path.join(bundlePath, weightsName);
  const draftersPath = path.join(bundlePath, draftersName);
  writeFileSync(weightsPath, "stub-gguf-bytes");
  writeFileSync(draftersPath, "stub-drafter-bytes");
  const manifest: Record<string, unknown> = {
    bundleId: overrides.bundleId ?? "eliza-1-0.6b",
    modelSize: overrides.modelSize ?? "0.6b",
    releaseState: overrides.releaseState ?? "local-standin",
    publishEligible: overrides.publishEligible ?? false,
    final: overrides.final ?? { weights: false },
    weightsPath: overrides.weightsPath ?? weightsName,
    sha256:
      overrides.sha256 ??
      "0000000000000000000000000000000000000000000000000000000000000000",
  };
  if (overrides.draftersPath !== undefined) {
    manifest.draftersPath = overrides.draftersPath;
  } else {
    manifest.draftersPath = draftersName;
  }
  for (const omit of overrides.omit ?? []) {
    delete manifest[omit];
  }
  writeFileSync(
    path.join(bundlePath, "manifest.json"),
    JSON.stringify(manifest),
  );
  return { bundlePath, weightsPath, draftersPath };
}

describe("readElizaOneBundle", () => {
  it("reads a local-standin manifest with resolved absolute weights/drafters paths", async () => {
    const { bundlePath, weightsPath, draftersPath } = makeBundle();
    const m = await readElizaOneBundle(bundlePath);
    expect(m.bundleId).toBe("eliza-1-0.6b");
    expect(m.modelSize).toBe("0.6b");
    expect(m.releaseState).toBe("local-standin");
    expect(m.publishEligible).toBe(false);
    expect(m.final.weights).toBe(false);
    expect(m.weightsPath).toBe(weightsPath);
    expect(m.draftersPath).toBe(draftersPath);
    expect(m.sha256).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("treats draftersPath as optional", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eliza-1-bundle-test-"));
    const bundlePath = path.join(root, "eliza-1-0.6b.bundle");
    mkdirSync(bundlePath, { recursive: true });
    writeFileSync(path.join(bundlePath, "weights.gguf"), "x");
    writeFileSync(
      path.join(bundlePath, "manifest.json"),
      JSON.stringify({
        bundleId: "eliza-1-0.6b",
        modelSize: "0.6b",
        releaseState: "local-standin",
        publishEligible: false,
        final: { weights: false },
        weightsPath: "weights.gguf",
        sha256: "abc",
      }),
    );
    const m = await readElizaOneBundle(bundlePath);
    expect(m.draftersPath).toBeUndefined();
  });
=======
	const root = mkdtempSync(path.join(tmpdir(), "eliza-1-bundle-test-"));
	const bundlePath = path.join(root, "eliza-1-0.8b.bundle");
	mkdirSync(bundlePath, { recursive: true });
	const weightsName = "weights.gguf";
	const draftersName = "drafter.gguf";
	const weightsPath = path.join(bundlePath, weightsName);
	const draftersPath = path.join(bundlePath, draftersName);
	writeFileSync(weightsPath, "stub-gguf-bytes");
	writeFileSync(draftersPath, "stub-drafter-bytes");
	const manifest: Record<string, unknown> = {
		bundleId: overrides.bundleId ?? "eliza-1-0.8b",
		modelSize: overrides.modelSize ?? "0.8b",
		releaseState: overrides.releaseState ?? "local-standin",
		publishEligible: overrides.publishEligible ?? false,
		final: overrides.final ?? { weights: false },
		weightsPath: overrides.weightsPath ?? weightsName,
		sha256:
			overrides.sha256 ??
			"0000000000000000000000000000000000000000000000000000000000000000",
	};
	if (overrides.draftersPath !== undefined) {
		manifest.draftersPath = overrides.draftersPath;
	} else {
		manifest.draftersPath = draftersName;
	}
	for (const omit of overrides.omit ?? []) {
		delete manifest[omit];
	}
	writeFileSync(
		path.join(bundlePath, "manifest.json"),
		JSON.stringify(manifest),
	);
	return { bundlePath, weightsPath, draftersPath };
}

describe("readElizaOneBundle", () => {
	it("reads a local-standin manifest with resolved absolute weights/drafters paths", async () => {
		const { bundlePath, weightsPath, draftersPath } = makeBundle();
		const m = await readElizaOneBundle(bundlePath);
		expect(m.bundleId).toBe("eliza-1-0.8b");
		expect(m.modelSize).toBe("0.8b");
		expect(m.releaseState).toBe("local-standin");
		expect(m.publishEligible).toBe(false);
		expect(m.final.weights).toBe(false);
		expect(m.weightsPath).toBe(weightsPath);
		expect(m.draftersPath).toBe(draftersPath);
		expect(m.sha256).toBe(
			"0000000000000000000000000000000000000000000000000000000000000000",
		);
	});

	it("treats draftersPath as optional", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "eliza-1-bundle-test-"));
		const bundlePath = path.join(root, "eliza-1-0.8b.bundle");
		mkdirSync(bundlePath, { recursive: true });
		writeFileSync(path.join(bundlePath, "weights.gguf"), "x");
		writeFileSync(
			path.join(bundlePath, "manifest.json"),
			JSON.stringify({
				bundleId: "eliza-1-0.8b",
				modelSize: "0.8b",
				releaseState: "local-standin",
				publishEligible: false,
				final: { weights: false },
				weightsPath: "weights.gguf",
				sha256: "abc",
			}),
		);
		const m = await readElizaOneBundle(bundlePath);
		expect(m.draftersPath).toBeUndefined();
	});
>>>>>>> origin/shaw/fine-tune-apollo-pipeline

  it("rejects an invalid modelSize", async () => {
    const { bundlePath } = makeBundle({ modelSize: "13b" });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /invalid 'modelSize'/,
    );
  });

  it("rejects an invalid releaseState", async () => {
    const { bundlePath } = makeBundle({ releaseState: "bogus" });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /invalid 'releaseState'/,
    );
  });

  it("rejects a missing publishEligible", async () => {
    const { bundlePath } = makeBundle({ omit: ["publishEligible"] });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /'publishEligible'/,
    );
  });

  it("rejects a missing final.weights", async () => {
    const { bundlePath } = makeBundle({
      final: { weights: undefined as unknown as boolean },
    });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /'final.weights'/,
    );
  });

  it("rejects when the referenced weights file does not exist", async () => {
    const { bundlePath } = makeBundle({ weightsPath: "missing.gguf" });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /weights file does not exist/,
    );
  });

  it("rejects when the bundle directory itself does not exist", async () => {
    await expect(
      readElizaOneBundle("/nonexistent/path/eliza-1.bundle"),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects an absolute weightsPath whose target is missing", async () => {
    const { bundlePath } = makeBundle({
      weightsPath: "/abs/missing/weights.gguf",
    });
    await expect(readElizaOneBundle(bundlePath)).rejects.toThrow(
      /weights file does not exist/,
    );
  });
});

function manifest(
  overrides: Partial<Omit<ElizaOneBundleManifest, "final">> & {
    finalWeights?: boolean;
  },
): ElizaOneBundleManifest {
<<<<<<< HEAD
  return {
    bundleId: overrides.bundleId ?? "eliza-1-0.6b",
    modelSize: overrides.modelSize ?? "0.6b",
    releaseState: overrides.releaseState ?? "local-standin",
    publishEligible: overrides.publishEligible ?? false,
    final: { weights: overrides.finalWeights ?? false },
    weightsPath: overrides.weightsPath ?? "/tmp/weights.gguf",
    draftersPath: overrides.draftersPath,
    sha256: overrides.sha256 ?? "abc",
  };
=======
	return {
		bundleId: overrides.bundleId ?? "eliza-1-0.8b",
		modelSize: overrides.modelSize ?? "0.8b",
		releaseState: overrides.releaseState ?? "local-standin",
		publishEligible: overrides.publishEligible ?? false,
		final: { weights: overrides.finalWeights ?? false },
		weightsPath: overrides.weightsPath ?? "/tmp/weights.gguf",
		draftersPath: overrides.draftersPath,
		sha256: overrides.sha256 ?? "abc",
	};
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
}

describe("bundleIsPreRelease", () => {
  it("flags any local-standin manifest as pre-release", () => {
    expect(bundleIsPreRelease(manifest({}))).toBe(true);
  });

  it("flags a candidate manifest as pre-release", () => {
    expect(
      bundleIsPreRelease(
        manifest({
          releaseState: "candidate",
          publishEligible: false,
          finalWeights: false,
        }),
      ),
    ).toBe(true);
  });

  it("flags a final manifest with publishEligible=false as pre-release", () => {
    expect(
      bundleIsPreRelease(
        manifest({
          releaseState: "final",
          publishEligible: false,
          finalWeights: true,
        }),
      ),
    ).toBe(true);
  });

  it("flags a final manifest with final.weights=false as pre-release", () => {
    expect(
      bundleIsPreRelease(
        manifest({
          releaseState: "final",
          publishEligible: true,
          finalWeights: false,
        }),
      ),
    ).toBe(true);
  });

  it("returns false ONLY when every gate is green", () => {
    expect(
      bundleIsPreRelease(
        manifest({
          releaseState: "final",
          publishEligible: true,
          finalWeights: true,
        }),
      ),
    ).toBe(false);
  });
});
