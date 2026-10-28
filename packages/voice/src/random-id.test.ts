import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id.js";

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when available", () => {
    expect(randomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back without crypto.randomUUID instead of throwing", () => {
    vi.stubGlobal("crypto", {});
    const first = randomId();
    const second = randomId();
    expect(first).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
    expect(first).not.toBe(second);
  });
});
