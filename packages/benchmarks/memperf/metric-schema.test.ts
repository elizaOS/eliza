/**
 * Schema-contract tests for the memperf metric schema (#8809).
 *
 * Run: bun test packages/benchmarks/memperf/metric-schema.test.ts
 *
 * These guard the SHARED contract with #8800 — a rename or a dropped field here
 * silently breaks the mobile workbench's column alignment, so the field list is
 * pinned. No models, no network: pure schema assertions, CI-safe everywhere.
 */

import { describe, expect, it } from "bun:test";

import {
  METRIC_SCHEMA,
  METRIC_SCHEMA_VERSION,
  MODALITIES,
  skippedModalityRow,
  THROUGHPUT_UNIT,
} from "./metric-schema.mjs";

describe("memperf metric schema", () => {
  it("pins the modality set the harness emits one row per (tier × modality)", () => {
    expect([...MODALITIES]).toEqual([
      "text",
      "embedding",
      "transcription",
      "tts",
      "vad",
      "vision",
    ]);
  });

  it("declares a throughput unit (tok/s or rtf) for every modality", () => {
    for (const m of MODALITIES) {
      expect(THROUGHPUT_UNIT[m]).toMatch(/^(tok\/s|rtf)$/);
    }
  });

  it("documents that the schema is shared with #8809 and #8800", () => {
    expect(METRIC_SCHEMA.sharedWith).toContain("#8809");
    expect(METRIC_SCHEMA.sharedWith).toContain("#8800");
    expect(METRIC_SCHEMA.version).toBe(METRIC_SCHEMA_VERSION);
  });

  it("pins the per-row field names so consumers can rely on them", () => {
    // The mobile workbench (#8800) reads these by name — a drop/rename is a
    // breaking change and must bump METRIC_SCHEMA_VERSION.
    expect(METRIC_SCHEMA.modalityFields).toEqual([
      "tier",
      "modality",
      "measured",
      "skipReason",
      "loadMs",
      "firstResultMs",
      "throughput",
      "throughputUnit",
      "rssBeforeMb",
      "rssAfterMb",
      "rssDeltaMb",
      "peakRssMb",
      "estimatedMb",
    ]);
    expect(METRIC_SCHEMA.coResidencyFields).toEqual([
      "measured",
      "mode",
      "sequence",
      "loadCount",
      "evictionCount",
      "pressureEvents",
      "budgetMb",
      "evictions",
    ]);
  });

  it("skippedModalityRow yields a measured:false row with every schema field present", () => {
    const row = skippedModalityRow("eliza-1-2b", "tts", "no bundle");
    expect(row.measured).toBe(false);
    expect(row.skipReason).toBe("no bundle");
    expect(row.throughputUnit).toBe("rtf"); // tts → rtf
    // Every pinned modality field must exist on the row (null for unmeasured).
    for (const field of METRIC_SCHEMA.modalityFields) {
      expect(field in row).toBe(true);
    }
    // Numeric metrics are null (not 0 — never conflate "not measured" with zero).
    expect(row.loadMs).toBeNull();
    expect(row.peakRssMb).toBeNull();
    expect(row.rssDeltaMb).toBeNull();
    expect(row.throughput).toBeNull();
  });
});
