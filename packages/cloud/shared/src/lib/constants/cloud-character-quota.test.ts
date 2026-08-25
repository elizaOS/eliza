/**
 * Coverage for cloud-character-quota.
 */
import { describe, expect, it } from "vitest";
import {
  getMaxCloudCharactersForOrg,
  resolveMaxCloudCharactersForOrg,
} from "./cloud-character-quota.js";

describe("cloud-character-quota", () => {
  it("resolves limits", () => {
    expect(resolveMaxCloudCharactersForOrg(undefined).limit).toBe(5);
    expect(getMaxCloudCharactersForOrg(0.5)).toBe(5);
    expect(getMaxCloudCharactersForOrg(2)).toBe(20);
  });
  it("throws on bad", () => {
    expect(() => resolveMaxCloudCharactersForOrg(NaN)).toThrow();
  });
});
