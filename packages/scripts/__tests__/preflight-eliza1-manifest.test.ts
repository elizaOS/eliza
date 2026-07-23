/**
 * Exercises the Local Inference Bench preflight boundary and pins its published
 * tier URLs to the shared runtime catalog. Fetches are deterministic Response
 * objects; the separate live command verifies the current Hugging Face state.
 */

import { describe, expect, test } from "bun:test";
import {
  ELIZA_1_PUBLISHED_SLUGS,
  ELIZA_1_PUBLISHED_TIER_IDS,
  ELIZA_1_TIER_IDS,
  eliza1TierPublishStatus,
  MODEL_CATALOG,
  tierPublishedSlug,
} from "@elizaos/shared/local-inference";
import {
  HF_REPO,
  manifestUrl,
  runPreflight,
  TIER_SLUG,
  validateShape,
} from "../benchmark/preflight-eliza1-manifest.mjs";

function writer() {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

function validManifest() {
  return {
    files: {
      text: [{}],
      voice: [{}],
      cache: [{}],
      asr: [],
      vision: [],
      mtp: [],
    },
  };
}

describe("published tier contract", () => {
  test("preflight covers exactly the manifest-backed tiers", () => {
    expect(TIER_SLUG).toEqual(ELIZA_1_PUBLISHED_SLUGS);
    expect(Object.keys(TIER_SLUG)).toEqual([...ELIZA_1_PUBLISHED_TIER_IDS]);
    for (const id of ELIZA_1_TIER_IDS) {
      const published = ELIZA_1_PUBLISHED_TIER_IDS.includes(
        id as (typeof ELIZA_1_PUBLISHED_TIER_IDS)[number],
      );
      expect(eliza1TierPublishStatus(id)).toBe(
        published ? "published" : "pending",
      );
      expect(tierPublishedSlug(id)).toBe(
        published ? TIER_SLUG[id as keyof typeof TIER_SLUG] : undefined,
      );
    }
  });

  test("preflight URL is the runtime downloader manifest URL", () => {
    for (const id of ELIZA_1_PUBLISHED_TIER_IDS) {
      const model = MODEL_CATALOG.find((entry) => entry.id === id);
      const slug = tierPublishedSlug(id);
      expect(model?.hfRepo).toBe(HF_REPO);
      expect(model?.hfPathPrefix).toBe(`bundles/${slug}`);
      expect(manifestUrl(id, "https://hf.invalid/")).toBe(
        `https://hf.invalid/${HF_REPO}/resolve/main/bundles/${slug}/eliza-1.manifest.json?download=true`,
      );
    }
  });

  test("pending and unknown tiers fail before network access", () => {
    expect(() => manifestUrl("eliza-1-9b")).toThrow(/not published/);
    expect(() => manifestUrl("eliza-1-does-not-exist")).toThrow(
      /not published/,
    );
  });
});

describe("preflight boundary", () => {
  test("accepts a reachable manifest with every required bucket", async () => {
    const stdout = writer();
    const stderr = writer();
    const code = await runPreflight(["eliza-1-2b"], {
      fetchImpl: async () => Response.json(validManifest()),
      stdout,
      stderr,
      baseUrl: "https://hf.invalid",
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("manifest shape OK");
    expect(stderr.text()).toBe("");
  });

  test("reports HTTP failures with the exact manifest URL", async () => {
    const stderr = writer();
    const code = await runPreflight(["eliza-1-2b"], {
      fetchImpl: async () => new Response("missing", { status: 404 }),
      stdout: writer(),
      stderr,
      baseUrl: "https://hf.invalid",
    });
    expect(code).toBe(2);
    expect(stderr.text()).toContain("HTTP 404");
    expect(stderr.text()).toContain("/bundles/e2b/eliza-1.manifest.json");
  });

  test("reports malformed buckets and invalid JSON", async () => {
    const malformed = writer();
    expect(
      await runPreflight(["eliza-1-2b"], {
        fetchImpl: async () =>
          Response.json({ files: { text: [], voice: "bad" } }),
        stdout: writer(),
        stderr: malformed,
      }),
    ).toBe(2);
    expect(malformed.text()).toContain("files.text");
    expect(malformed.text()).toContain("files.voice");
    expect(malformed.text()).toContain("files.cache");

    const invalidJson = writer();
    expect(
      await runPreflight(["eliza-1-2b"], {
        fetchImpl: async () =>
          new Response("{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        stdout: writer(),
        stderr: invalidJson,
      }),
    ).toBe(2);
    expect(invalidJson.text()).toContain("preflight-manifest");
  });

  test("rejects empty invocations and validates non-object files", async () => {
    const stderr = writer();
    expect(
      await runPreflight([], {
        fetchImpl: async () => Response.json(validManifest()),
        stdout: writer(),
        stderr,
      }),
    ).toBe(2);
    expect(stderr.text()).toContain("no tier ids supplied");
    expect(validateShape({ files: [] })).toEqual([
      "`files` is missing or not an object",
    ]);
  });
});
