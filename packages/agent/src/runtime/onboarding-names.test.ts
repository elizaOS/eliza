import { describe, expect, it } from "vitest";

import {
  AGENT_NAME_POOL,
  DEFAULT_AGENT_NAME,
  pickRandomNames,
} from "./onboarding-names.js";

describe("onboarding names", () => {
  it("keeps Eliza as the default onboarding option", () => {
    expect(DEFAULT_AGENT_NAME).toBe("Eliza");
    expect(AGENT_NAME_POOL[0]).toBe(DEFAULT_AGENT_NAME);
    expect(pickRandomNames(1)).toEqual([DEFAULT_AGENT_NAME]);
  });

  it("returns unique names while preserving the default first", () => {
    const names = pickRandomNames(5);

    expect(names).toHaveLength(5);
    expect(names[0]).toBe(DEFAULT_AGENT_NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  it("clamps requested names to the available pool", () => {
    expect(pickRandomNames(0)).toEqual([]);
    expect(pickRandomNames(AGENT_NAME_POOL.length + 10)).toHaveLength(
      AGENT_NAME_POOL.length,
    );
  });
});
