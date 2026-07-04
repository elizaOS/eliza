// Exercises video generation pricing behavior with deterministic cloud-shared lib fixtures.
import { expect, test } from "bun:test";
import { SUPPORTED_VIDEO_MODELS } from "../ai-pricing-definitions";
import type { PreparedPricingEntry } from "./types";

const { fetchAtlasCloudCatalogEntries } = await import("./providers/atlascloud");

async function collectAtlasVideoGenerationRows(): Promise<PreparedPricingEntry[]> {
  const rows = await fetchAtlasCloudCatalogEntries();
  return rows.filter(
    (row) =>
      row.billingSource === "atlascloud" &&
      row.productFamily === "video" &&
      row.chargeType === "generation",
  );
}

test("every supported Atlas video model has a video:generation pricing row", async () => {
  const atlasVideoModels = SUPPORTED_VIDEO_MODELS.filter(
    (model) => model.billingSource === "atlascloud",
  );
  const rows = await collectAtlasVideoGenerationRows();

  expect(atlasVideoModels.length).toBeGreaterThan(0);
  for (const model of atlasVideoModels) {
    const row = rows.find((candidate) => candidate.model === model.modelId);
    expect(row).toBeDefined();
    expect(row?.unit).toBe("second");
    expect(row?.provider).toBe(model.provider);
    expect(row?.unitPrice ?? 0).toBeGreaterThan(0);
    expect(row?.sourceUrl).toBe(model.pageUrl);
  }
});

test("Atlas video rows key on { resolution, audio } and never on durationSeconds", async () => {
  // Regression (#11785): durationSeconds must NOT be a pricing dimension — the
  // route doesn't inject it into requested dims for atlascloud, so seeding it
  // makes the dimension-subset match always fail. Each row must carry a
  // resolution dimension and audio:false to match the route-shaped request.
  const rows = await collectAtlasVideoGenerationRows();

  for (const row of rows) {
    expect(row.dimensions).toBeDefined();
    expect(row.dimensions?.durationSeconds).toBeUndefined();
    expect(typeof row.dimensions?.resolution).toBe("string");
    expect(row.dimensions?.audio).toBe(false);
  }
});

test("Vidu q3-turbo emits per-resolution rows (540p/720p/1080p) at $0.04/$0.06/$0.08 per second", async () => {
  const rows = await collectAtlasVideoGenerationRows();
  const expectedByResolution: Record<string, number> = {
    "540p": 0.04,
    "720p": 0.06,
    "1080p": 0.08,
  };

  for (const [resolution, unitPrice] of Object.entries(expectedByResolution)) {
    const row = rows.find(
      (candidate) =>
        candidate.model === "vidu/q3-turbo/text-to-video" &&
        candidate.dimensions?.resolution === resolution,
    );
    expect(row, `expected q3-turbo row for ${resolution}`).toBeDefined();
    expect(row?.unitPrice).toBe(unitPrice);
  }
});

test("Vidu image-to-video-2.0 stays flat $0.075/s across resolution rows", async () => {
  const rows = await collectAtlasVideoGenerationRows().then((all) =>
    all.filter((row) => row.model === "vidu/image-to-video-2.0"),
  );

  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.unitPrice).toBe(0.075);
  }
});
