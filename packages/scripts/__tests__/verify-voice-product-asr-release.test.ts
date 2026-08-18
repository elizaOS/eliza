/**
 * Verifies the product-ASR publication gate and its Voice Live E2E wiring with
 * deterministic release fixtures and mocked resolver metadata, without model
 * downloads.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  latestDeclaredAsrRelease,
  validateProductAsrRelease,
  verifyProductAsrReleaseAuthority,
} from "../verify-voice-product-asr-release.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const REVISION = "c".repeat(40);

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: "asr",
    version: "1.0.0",
    publishedToHfAt: "2026-08-17T00:00:00Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: REVISION,
    ggufAssets: [
      {
        filename: "voice/asr/eliza-1-gemma-asr-q4_0.gguf",
        sha256: SHA_A,
        sizeBytes: 1_000,
        quant: "q4_0",
      },
      {
        filename: "voice/asr/eliza-1-gemma-asr-mmproj.gguf",
        sha256: SHA_B,
        sizeBytes: 200,
        quant: "f16",
      },
    ],
    changelogEntry: "Verified Gemma ASR release.",
    minBundleVersion: "1.0.0",
    ...overrides,
  };
}

describe("product ASR release authority", () => {
  it("selects the newest declaration instead of falling back to a retired release", () => {
    const retired = release({ version: "0.2.0" });
    const pending = release({
      version: "0.3.0",
      hfRevision: "pending",
      ggufAssets: [],
    });
    expect(latestDeclaredAsrRelease([retired, pending])).toBe(pending);
  });

  it("rejects the current pending release and legacy compatibility-only assets", () => {
    const result = validateProductAsrRelease([
      release({ version: "0.2.0" }),
      release({
        version: "0.3.0",
        hfRevision: "pending",
        ggufAssets: [],
        missingAssets: [
          {
            filename: "voice/asr/eliza-1-gemma-asr-q4_0.gguf",
            reason: "missing-from-hf-repo",
          },
        ],
      }),
    ]);

    expect(result.release?.version).toBe("0.3.0");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("immutable 40-character"),
        expect.stringContaining("still declares missing assets"),
        expect.stringContaining("no downloadable GGUF assets"),
        expect.stringContaining("Gemma ASR model and its mmproj projector"),
      ]),
    );
  });

  it("accepts an immutable, size- and hash-pinned Gemma model/projector pair", () => {
    expect(validateProductAsrRelease([release()]).errors).toEqual([]);
  });

  it("rejects plausible catalog pins when Hugging Face does not bind them to real assets", async () => {
    const result = await verifyProductAsrReleaseAuthority([release()], {
      fetchFn: async () =>
        new Response(null, {
          status: 404,
          headers: { "x-repo-commit": REVISION },
        }),
    });

    expect(result.errors).toHaveLength(2);
    expect(
      result.errors.every((error) => error.includes("not downloadable")),
    ).toBe(true);
  });

  it("requires resolver commit, digest, size, and download-location authority", async () => {
    const published = release();
    const assets = published.ggufAssets as Array<{
      filename: string;
      sha256: string;
      sizeBytes: number;
    }>;
    const result = await verifyProductAsrReleaseAuthority([published], {
      fetchFn: async (url: string | URL | Request) => {
        const asset = assets.find(({ filename }) =>
          String(url).endsWith(filename),
        );
        if (!asset) throw new Error("unexpected asset URL");
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://cdn.example.invalid/immutable-object",
            "x-linked-etag": `"${asset.sha256}"`,
            "x-linked-size": String(asset.sizeBytes),
            "x-repo-commit": REVISION,
          },
        });
      },
    });

    expect(result.errors).toEqual([]);
  });

  it("rejects generic model/projector pairs that are not declared as Gemma ASR", () => {
    const generic = release({
      ggufAssets: [
        {
          filename: "voice/asr/generic-model.gguf",
          sha256: SHA_A,
          sizeBytes: 1_000,
          quant: "q4_0",
        },
        {
          filename: "voice/asr/generic-mmproj.gguf",
          sha256: SHA_B,
          sizeBytes: 200,
          quant: "f16",
        },
      ],
    });

    expect(validateProductAsrRelease([generic]).errors).toContainEqual(
      expect.stringContaining("Gemma ASR model"),
    );
  });

  it("keeps Voice Live E2E red while explicitly labeling compatibility evidence", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/voice-live-e2e.yml", import.meta.url),
      "utf8",
    );
    const action = readFileSync(
      new URL(
        "../../../.github/actions/stage-voice-real-assets/action.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("voice-product-asr-release:");
    expect(workflow).toContain(
      "bun packages/scripts/verify-voice-product-asr-release.mjs --github-annotations",
    );
    expect(workflow).toContain("Pre-Gemma ASR compatibility FFI");
    expect(action).toContain("Stage voice compatibility assets");
    expect(action).toContain("not product-runtime ASR evidence");
  });
});
