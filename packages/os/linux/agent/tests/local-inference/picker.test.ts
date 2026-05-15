// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import {
  formatPickResultForChat,
  recommendModelTierFor,
} from "../../src/local-inference/picker.ts";

describe("recommendModelTierFor", () => {
  test("32 GB host gets the eliza-1-9b recommendation", () => {
    const result = recommendModelTierFor(32);
    expect(result.recommended.id).toBe("eliza-1-9b");
    expect(result.drafter).toBeDefined();
    expect(result.drafter?.id).toBe("eliza-1-9b-drafter");
    expect(result.hostRamGb).toBe(32);
  });

  test("16 GB host also gets eliza-1-9b (exactly fits at minRam+headroom)", () => {
    const result = recommendModelTierFor(16);
    expect(result.recommended.id).toBe("eliza-1-9b");
  });

  test("12 GB host falls to eliza-1-2b", () => {
    const result = recommendModelTierFor(12);
    expect(result.recommended.id).toBe("eliza-1-2b");
    expect(result.drafter?.id).toBe("eliza-1-2b-drafter");
  });

  test("8 GB host gets eliza-1-2b", () => {
    const result = recommendModelTierFor(8);
    expect(result.recommended.id).toBe("eliza-1-2b");
  });

  test("4 GB low-end laptop still gets the baseline", () => {
    const result = recommendModelTierFor(4);
    expect(result.recommended.id).toBe("eliza-1-0_8b");
    expect(result.alternatives).toEqual([]);
  });

  test("64 GB workstation gets eliza-1-27b as top pick", () => {
    const result = recommendModelTierFor(64);
    expect(result.recommended.id).toBe("eliza-1-27b");
    const altIds = result.alternatives.map((a) => a.id);
    expect(altIds).toContain("eliza-1-9b");
    expect(altIds).toContain("eliza-1-4b");
    expect(altIds).toContain("eliza-1-0_8b");
  });
});

describe("formatPickResultForChat", () => {
  test("renders a complete pick result with drafter + alternatives", () => {
    const result = recommendModelTierFor(32);
    const text = formatPickResultForChat(result);
    expect(text).toContain("32 GB of RAM");
    expect(text).toContain("eliza-1-9b");
    expect(text).toContain("eliza-1-9b drafter");
    expect(text).toContain("speculative-decoding drafter");
    expect(text).toContain("Alternatives:");
  });

  test("renders a baseline-only result (no alternatives, no drafter)", () => {
    const result = recommendModelTierFor(4);
    const text = formatPickResultForChat(result);
    expect(text).toContain("4 GB of RAM");
    expect(text).toContain("eliza-1-0_8b");
    expect(text).not.toContain("speculative-decoding drafter");
    expect(text).not.toContain("Alternatives:");
  });
});
