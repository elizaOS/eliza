/**
 * Regression for #11005: every SUPPORTED_IMAGE_MODELS entry MUST have an
 * `image:generation` pricing row, or /v1/generate-image (and the apps + A2A
 * image paths) 500 "Pricing unavailable for image:generation" at the cost
 * estimate BEFORE dispatch.
 *
 * The six former `billingSource: "bitrouter"` image models
 * (google/gemini-*-image*, openai/gpt-5*-image*) had NO generation row —
 * BitRouter's pricing builder emits only token input/output rows — so every
 * request that resolved them 500'd. They were removed; the catalog now only
 * lists atlascloud/fal models whose builders emit static
 * `chargeType: "generation"` snapshot rows.
 *
 * Deliberately NO `mock.module` here: bun module mocks are process-global and
 * last-writer-wins across test files (see lookup-missing-pricing.test.ts,
 * which empties the gateway seam), so this file asserts against the real
 * static snapshot builders directly — no DB, no network, no leakage in either
 * direction.
 */
import { expect, test } from "bun:test";
import {
  DEFAULT_IMAGE_MODEL_ID,
  SUPPORTED_IMAGE_MODEL_IDS,
  SUPPORTED_IMAGE_MODELS,
} from "../ai-pricing-definitions";
import type { PreparedPricingEntry } from "./types";

const { fetchAtlasCloudCatalogEntries } = await import("./providers/atlascloud");
const { buildFalImageSnapshotEntries } = await import("./providers/fal");

async function collectImageGenerationRows(): Promise<PreparedPricingEntry[]> {
  // fetchAtlasCloudCatalogEntries wraps a pure in-code snapshot (no network);
  // buildFalImageSnapshotEntries is the fal in-code snapshot (the fal video
  // page-scrapes are not involved).
  const rows = [...(await fetchAtlasCloudCatalogEntries()), ...buildFalImageSnapshotEntries()];
  return rows.filter((row) => row.productFamily === "image" && row.chargeType === "generation");
}

test("every supported image model has an image:generation pricing row (no 500)", async () => {
  const rows = await collectImageGenerationRows();
  expect(SUPPORTED_IMAGE_MODELS.length).toBeGreaterThan(0);

  for (const model of SUPPORTED_IMAGE_MODELS) {
    const row = rows.find(
      (candidate) =>
        candidate.model === model.modelId && candidate.billingSource === model.billingSource,
    );
    expect(row).toBeDefined();
    expect(row?.unit).toBe("image");
    expect(row?.unitPrice ?? 0).toBeGreaterThan(0);
  }
});

test("the default image model is supported and generation-priced", async () => {
  expect(SUPPORTED_IMAGE_MODEL_IDS).toContain(DEFAULT_IMAGE_MODEL_ID);

  const rows = await collectImageGenerationRows();
  const row = rows.find((candidate) => candidate.model === DEFAULT_IMAGE_MODEL_ID);
  expect(row).toBeDefined();
  expect(row?.unitPrice ?? 0).toBeGreaterThan(0);
});

test("the unpriced bitrouter image models are gone — catalog and pricing rows", async () => {
  const removed = [
    "google/gemini-2.5-flash-image",
    "google/gemini-3-pro-image-preview",
    "google/gemini-3.1-flash-image-preview",
    "openai/gpt-5.4-image-2",
    "openai/gpt-5-image-mini",
    "openai/gpt-5-image",
  ];
  const rows = await collectImageGenerationRows();
  for (const modelId of removed) {
    expect(SUPPORTED_IMAGE_MODEL_IDS).not.toContain(modelId);
    expect(rows.some((row) => row.model === modelId)).toBe(false);
  }
  // No image model may bill through bitrouter: its pricing builder emits only
  // token rows, so a bitrouter image model can never be generation-priced.
  expect(SUPPORTED_IMAGE_MODELS.some((m) => m.billingSource === "bitrouter")).toBe(false);
});
