import type { CatalogModel } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eliza1TierPublishStatus, MODEL_CATALOG } from "./catalog";
import { recommendForFirstRun } from "./recommendation";

// elizaOS/eliza#7629 — first-run recommender must walk past tiers whose
// HF bundle isn't published yet rather than route the user to a 404.

const ENV_KEYS = ["ELIZA_PUBLISH_STATUS_OVERRIDES"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function clone(
  entry: CatalogModel,
  overrides: Partial<CatalogModel>,
): CatalogModel {
  return { ...entry, ...overrides };
}

describe("eliza1TierPublishStatus", () => {
  it("defaults every Eliza-1 tier to 'published' when no overrides are set", () => {
    expect(eliza1TierPublishStatus("eliza-1-0_8b")).toBe("published");
    expect(eliza1TierPublishStatus("eliza-1-2b")).toBe("published");
    expect(eliza1TierPublishStatus("eliza-1-4b")).toBe("published");
    expect(eliza1TierPublishStatus("eliza-1-9b")).toBe("published");
    expect(eliza1TierPublishStatus("eliza-1-27b")).toBe("published");
  });

  it("returns 'pending' when ELIZA_PUBLISH_STATUS_OVERRIDES marks a tier pending", () => {
    process.env.ELIZA_PUBLISH_STATUS_OVERRIDES = JSON.stringify({
      "eliza-1-9b": "pending",
    });
    expect(eliza1TierPublishStatus("eliza-1-9b")).toBe("pending");
    // Other tiers stay at their static default.
    expect(eliza1TierPublishStatus("eliza-1-2b")).toBe("published");
  });

  it("ignores malformed JSON in ELIZA_PUBLISH_STATUS_OVERRIDES and falls back to default", () => {
    process.env.ELIZA_PUBLISH_STATUS_OVERRIDES = "{not json";
    expect(eliza1TierPublishStatus("eliza-1-9b")).toBe("published");
  });

  it("ignores unrecognized status values in overrides (only 'published' / 'pending')", () => {
    process.env.ELIZA_PUBLISH_STATUS_OVERRIDES = JSON.stringify({
      "eliza-1-9b": "draft",
    });
    expect(eliza1TierPublishStatus("eliza-1-9b")).toBe("published");
  });

  it("returns 'published' for unknown ids (defensive — never block a custom tier)", () => {
    expect(eliza1TierPublishStatus("custom-model-id")).toBe("published");
  });
});

describe("recommendForFirstRun publish-status fallback (issue #7629)", () => {
  it("on a default catalog with no pending tiers, picks FIRST_RUN_DEFAULT_MODEL_ID", () => {
    const picked = recommendForFirstRun();
    expect(picked?.id).toBe("eliza-1-2b");
  });

  it("falls through when the preferred tier is marked publishStatus='pending'", () => {
    // Synthetic catalog: 2b is the preferred tier but its bundle isn't on
    // HF yet. Recommender should walk to the next eligible published tier.
    const catalog = MODEL_CATALOG.map((entry) =>
      entry.id === "eliza-1-2b"
        ? clone(entry, { publishStatus: "pending" })
        : entry,
    );
    const picked = recommendForFirstRun(catalog);
    expect(picked).not.toBeNull();
    expect(picked?.id).not.toBe("eliza-1-2b");
    expect(picked?.publishStatus ?? "published").toBe("published");
  });

  it("walks PAST multiple pending tiers in catalog order", () => {
    // Mark 0_8b, 2b, and 4b as pending; expect 9b (next published chat tier).
    const pending = new Set(["eliza-1-0_8b", "eliza-1-2b", "eliza-1-4b"]);
    const catalog = MODEL_CATALOG.map((entry) =>
      pending.has(entry.id)
        ? clone(entry, { publishStatus: "pending" })
        : entry,
    );
    const picked = recommendForFirstRun(catalog);
    expect(picked?.id).toBe("eliza-1-9b");
  });

  it("falls back to ANY default-eligible tier when EVERY chat tier is pending (download will surface the 404)", () => {
    // The bypass-of-last-resort: rather than return null and crash the
    // first-run UI, hand back a default-eligible tier so the downloader
    // emits a clear "manifest 404" message that points the user at the
    // publish gap rather than silently picking a non-Eliza model.
    const catalog = MODEL_CATALOG.map((entry) =>
      entry.runtimeRole === "dflash-drafter"
        ? entry
        : clone(entry, { publishStatus: "pending" }),
    );
    const picked = recommendForFirstRun(catalog);
    expect(picked).not.toBeNull();
    expect(picked?.id).toBe("eliza-1-2b");
    expect(picked?.publishStatus).toBe("pending");
  });

  it("honours ELIZA_PUBLISH_STATUS_OVERRIDES at runtime without catalog edits", () => {
    // Live-fix path documented in catalog.ts: a user whose preferred tier
    // is unpublished on HF can flip it locally without forking the
    // catalog. The override is read every call (no module-load cache),
    // so QA can re-run with different states.
    process.env.ELIZA_PUBLISH_STATUS_OVERRIDES = JSON.stringify({
      "eliza-1-2b": "pending",
      "eliza-1-0_8b": "pending",
    });
    // MODEL_CATALOG bakes the publish status at module-load time via
    // `eliza1TierPublishStatus`, but the env var was unset then. To make
    // the override observable end-to-end we build a synthetic catalog
    // that derives publishStatus per-call.
    const catalog = MODEL_CATALOG.map((entry) =>
      clone(entry, {
        publishStatus: eliza1TierPublishStatus(entry.id),
      }),
    );
    const picked = recommendForFirstRun(catalog);
    expect(picked).not.toBeNull();
    expect(picked?.id).not.toBe("eliza-1-2b");
    expect(picked?.id).not.toBe("eliza-1-0_8b");
  });

  it("never recommends a drafter companion regardless of publish status", () => {
    // Drafter entries are hidden, runtimeRole='dflash-drafter'. Even when
    // they sort earlier alphabetically they must never be the first-run
    // pick — they aren't a usable chat target.
    const catalog = MODEL_CATALOG.map((entry) =>
      entry.id === "eliza-1-2b"
        ? clone(entry, { publishStatus: "pending" })
        : entry,
    );
    const picked = recommendForFirstRun(catalog);
    expect(picked?.runtimeRole).not.toBe("dflash-drafter");
    expect(picked?.hiddenFromCatalog ?? false).toBe(false);
  });

  it("returns null only when no default-eligible entry exists in the catalog at all", () => {
    // Catalog with chat tiers stripped — caller should surface a hard
    // error, not degrade silently.
    const catalogWithoutChat = MODEL_CATALOG.filter(
      (entry) => entry.runtimeRole === "dflash-drafter",
    );
    expect(recommendForFirstRun(catalogWithoutChat)).toBeNull();
  });
});
