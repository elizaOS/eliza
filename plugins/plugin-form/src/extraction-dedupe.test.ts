/**
 * Pins value-based dedupe for form extractions and corrections: distinct
 * object values for the same field must both survive (they would collide as
 * "[object Object]" under `String()`), while exact duplicates collapse.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectCorrection, parseFormExtractorOutput } from "./extraction";
import type { FormControl } from "./types";

describe("parseFormExtractorOutput dedupe", () => {
  it("keeps distinct object values for one field and collapses exact duplicates", () => {
    const result = parseFormExtractorOutput({
      formIntent: "fill_form",
      formExtractions: [
        { field: "address", value: { city: "Busan" }, confidence: 0.9 },
        { field: "address", value: { city: "Seoul" }, confidence: 0.8 },
        { field: "address", value: { city: "Busan" }, confidence: 0.7 },
      ],
    });

    expect(result?.extractions.map((e) => e.value)).toEqual([
      { city: "Busan" },
      { city: "Seoul" },
    ]);
  });
});

describe("detectCorrection dedupe", () => {
  const controls: FormControl[] = [
    { key: "address", label: "Address", type: "text" },
  ];

  function runtimeReturning(response: unknown): IAgentRuntime {
    return {
      useModel: async () => JSON.stringify(response),
      getService: () => null,
    } as unknown as IAgentRuntime;
  }

  it("keeps distinct object corrections for one field and collapses exact duplicates", async () => {
    const runtime = runtimeReturning({
      has_correction: true,
      corrections: [
        { field: "address", new_value: { city: "Busan" }, confidence: 0.9 },
        { field: "address", new_value: { city: "Seoul" }, confidence: 0.8 },
        { field: "Address", new_value: { city: "Busan" }, confidence: 0.7 },
      ],
    });

    const corrections = await detectCorrection(
      runtime,
      "actually my address is Busan, or Seoul",
      { address: { city: "Daegu" } },
      controls,
    );

    expect(corrections.map((c) => c.value)).toEqual([
      { city: "Busan" },
      { city: "Seoul" },
    ]);
    expect(corrections.every((c) => c.isCorrection)).toBe(true);
  });
});
