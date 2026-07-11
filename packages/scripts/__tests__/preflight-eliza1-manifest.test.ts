// Parity guard for the Local Inference Bench manifest preflight.
//
// The nightly `Local Inference Bench` lane runs
// `packages/scripts/benchmark/preflight-eliza1-manifest.mjs` to fail fast when
// the PUBLISHED `elizaos/eliza-1` bundle manifest is malformed or unreachable,
// before spending ~5 minutes on a full `bun install` + agent boot. That
// preflight derives the published bundle path from its own `TIER_SLUG` map.
//
// The published `elizaos/eliza-1` tree was re-slugged during the 2026-06→07
// Gemma-4 cutover from size slugs (`2b`/`4b`/`9b`/`27b`/`27b-256k`) to
// architecture slugs (`e2b`/`e4b`/`12b`/`31b`/`31b-256k`). When the preflight's
// slug map drifted from the shared runtime catalog, the preflight validated a
// 404 path while the runtime downloader fetched a different one — the failure
// mode in issue #15976 (HTTP 404 for `bundles/2b/eliza-1.manifest.json`).
//
// This test pins the preflight's map to the shared catalog's single source of
// truth (`ELIZA_1_PUBLISHED_SLUGS`) and to the catalog-derived published bundle
// paths the runtime downloader uses, so the two can never silently diverge
// again. It runs offline (no HuggingFace fetch) — the network shape check lives
// in the preflight CLI itself.

import { describe, expect, test } from "bun:test";
import {
  ELIZA_1_PUBLISHED_SLUGS,
  ELIZA_1_TIER_IDS,
  MODEL_CATALOG,
  tierPublishedSlug,
} from "@elizaos/shared/local-inference";
import {
  HF_REPO,
  manifestUrl,
  TIER_SLUG,
} from "../benchmark/preflight-eliza1-manifest.mjs";

describe("preflight-eliza1-manifest ↔ shared catalog published-slug parity", () => {
  test("preflight TIER_SLUG equals the shared catalog ELIZA_1_PUBLISHED_SLUGS", () => {
    // Exact structural equality: same keys, same architecture-slug values.
    expect(TIER_SLUG).toEqual(ELIZA_1_PUBLISHED_SLUGS);
  });

  test("preflight covers every active tier id (no missing / extra tiers)", () => {
    expect(Object.keys(TIER_SLUG).sort()).toEqual([...ELIZA_1_TIER_IDS].sort());
    for (const id of ELIZA_1_TIER_IDS) {
      expect(TIER_SLUG[id]).toBe(tierPublishedSlug(id));
    }
  });

  test("published manifest URL uses the same bundle prefix as the runtime catalog", () => {
    // The runtime downloader fetches `hfPathPrefix/bundleManifestFile`; the
    // preflight must validate the exact same published path so a green
    // preflight guarantees the runtime download resolves the same URL.
    for (const id of ELIZA_1_TIER_IDS) {
      const entry = MODEL_CATALOG.find((m) => m.id === id);
      expect(entry).toBeDefined();
      const slug = tierPublishedSlug(id);
      // Catalog: bundle prefix carries the arch slug.
      expect(entry?.hfPathPrefix).toBe(`bundles/${slug}`);
      // Preflight: the manifest URL points at the same arch-slug bundle path
      // in the same HF repo.
      const url = manifestUrl(id);
      expect(url).toContain(`/${HF_REPO}/resolve/main/bundles/${slug}/`);
      expect(url).toContain("eliza-1.manifest.json");
      // The catalog's bundleManifestFile is the arch-slug bundle manifest.
      expect(entry?.hfRepo).toBe(HF_REPO);
    }
  });

  test("manifestUrl throws on an unknown tier id", () => {
    expect(() => manifestUrl("eliza-1-does-not-exist")).toThrow(
      /unknown tier id/,
    );
  });
});
