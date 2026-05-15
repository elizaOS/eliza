/**
 * Catalog-time variant indexing: OpenRouter lists models under snapshot ids
 * (e.g. `google/gemini-2.0-flash-001`) but clients send the unsuffixed
 * canonical id. The ingest now emits a low-priority duplicate row under the
 * stripped base id so lookups for the canonical id resolve without
 * maintaining a hand-curated alias map.
 */

import { describe, expect, test } from "bun:test";
import {
  buildOpenRouterPreparedEntries,
  stripVersionedSnapshotSuffix,
} from "@/lib/services/ai-pricing";

describe("stripVersionedSnapshotSuffix — dated and labelled suffixes", () => {
  test("strips compact 8-digit date suffix", () => {
    expect(stripVersionedSnapshotSuffix("anthropic/claude-3-5-haiku-20241022")).toBe(
      "anthropic/claude-3-5-haiku",
    );
  });

  test("strips ISO date suffix", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-2024-11-20")).toBe("openai/gpt-4o");
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-2024-08-06")).toBe("openai/gpt-4o");
  });

  test("strips -latest label", () => {
    expect(stripVersionedSnapshotSuffix("anthropic/claude-haiku-latest")).toBe(
      "anthropic/claude-haiku",
    );
  });

  test("strips -preview label", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-search-preview")).toBe(
      "openai/gpt-4o-search",
    );
  });

  test("strips -beta label", () => {
    expect(stripVersionedSnapshotSuffix("openai/o1-beta")).toBe("openai/o1");
  });

  test("dated suffix bypasses the 2-segment safety check for short bases", () => {
    expect(stripVersionedSnapshotSuffix("openai/o1-2024-12-17")).toBe("openai/o1");
  });
});

describe("stripVersionedSnapshotSuffix — numeric snapshot suffixes", () => {
  test("strips -001 numeric snapshot", () => {
    expect(stripVersionedSnapshotSuffix("google/gemini-2.0-flash-001")).toBe(
      "google/gemini-2.0-flash",
    );
    expect(stripVersionedSnapshotSuffix("google/gemini-2.0-flash-lite-001")).toBe(
      "google/gemini-2.0-flash-lite",
    );
  });

  test("strips multi-digit numeric snapshot when two+ segments remain", () => {
    expect(stripVersionedSnapshotSuffix("vendor/family-name-1234")).toBe("vendor/family-name");
    expect(stripVersionedSnapshotSuffix("vendor/family-name-99")).toBe("vendor/family-name");
  });

  test("does NOT strip when result would collapse to one segment after slash", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4")).toBeNull();
    expect(stripVersionedSnapshotSuffix("vendor/model-1234")).toBeNull();
  });
});

describe("stripVersionedSnapshotSuffix — must-not-strip cases", () => {
  test("returns null when no suffix pattern matches", () => {
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o-mini")).toBeNull();
    expect(stripVersionedSnapshotSuffix("anthropic/claude-3-5-haiku")).toBeNull();
    expect(stripVersionedSnapshotSuffix("google/gemini-2.5-flash")).toBeNull();
    expect(stripVersionedSnapshotSuffix("openai/gpt-4o")).toBeNull();
  });

  test("returns null when stripping would empty the id", () => {
    expect(stripVersionedSnapshotSuffix("001")).toBeNull();
    expect(stripVersionedSnapshotSuffix("latest")).toBeNull();
  });

  test("returns null when stripping would leave just a provider prefix", () => {
    expect(stripVersionedSnapshotSuffix("openai/123")).toBeNull();
    expect(stripVersionedSnapshotSuffix("anthropic/latest")).toBeNull();
  });

  test("returns null for ids without dash-version markers", () => {
    expect(stripVersionedSnapshotSuffix("openai")).toBeNull();
    expect(stripVersionedSnapshotSuffix("anthropic/")).toBeNull();
  });
});

describe("buildOpenRouterPreparedEntries — exact + stripped variants", () => {
  test("emits both exact and stripped rows for prompt and completion", () => {
    const entries = buildOpenRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    });

    const inputEntries = entries.filter((e) => e.chargeType === "input");
    const outputEntries = entries.filter((e) => e.chargeType === "output");

    expect(inputEntries).toHaveLength(2);
    expect(outputEntries).toHaveLength(2);

    const exactInput = inputEntries.find((e) => e.model === "google/gemini-2.0-flash-001");
    const strippedInput = inputEntries.find((e) => e.model === "google/gemini-2.0-flash");
    expect(exactInput?.priority).toBeUndefined();
    expect(strippedInput?.priority).toBe(-1);
    expect(exactInput?.unitPrice).toBe(strippedInput?.unitPrice);

    const exactOutput = outputEntries.find((e) => e.model === "google/gemini-2.0-flash-001");
    const strippedOutput = outputEntries.find((e) => e.model === "google/gemini-2.0-flash");
    expect(exactOutput?.priority).toBeUndefined();
    expect(strippedOutput?.priority).toBe(-1);
    expect(exactOutput?.unitPrice).toBe(strippedOutput?.unitPrice);
  });

  test("emits only exact rows when no suffix can be stripped", () => {
    const entries = buildOpenRouterPreparedEntries({
      id: "openai/gpt-4o-mini",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.model === "openai/gpt-4o-mini")).toBe(true);
    expect(entries.every((e) => e.priority === undefined)).toBe(true);
  });

  test("propagates provider, productFamily, billingSource on stripped row", () => {
    const entries = buildOpenRouterPreparedEntries({
      id: "anthropic/claude-3-5-haiku-20241022",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.0000008" },
    });

    const stripped = entries.find((e) => e.model === "anthropic/claude-3-5-haiku");
    expect(stripped).toBeDefined();
    expect(stripped?.provider).toBe("anthropic");
    expect(stripped?.productFamily).toBe("language");
    expect(stripped?.billingSource).toBe("openrouter");
    expect(stripped?.sourceKind).toBe("openrouter_catalog");
  });

  test("does not emit stripped row when prices are missing", () => {
    const entries = buildOpenRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: { modality: "text->text" },
      pricing: {},
    });

    expect(entries).toHaveLength(0);
  });

  test("emits stripped row only for the priced direction (input-only)", () => {
    const entries = buildOpenRouterPreparedEntries({
      id: "google/gemini-2.0-flash-001",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.0000001" },
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.chargeType === "input")).toBe(true);
    expect(entries.find((e) => e.model === "google/gemini-2.0-flash")?.priority).toBe(-1);
  });
});
