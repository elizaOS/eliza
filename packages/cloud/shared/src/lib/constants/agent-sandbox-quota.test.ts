/**
 * Coverage for agent-sandbox-quota.
 */
import { describe, expect, it } from "vitest";
import {
  getMaxNonTerminalAgentsForOrg,
  resolveMaxNonTerminalAgentsForOrg,
} from "./agent-sandbox-quota.js";

describe("agent-sandbox-quota", () => {
  it("resolves limits by balance", () => {
    expect(resolveMaxNonTerminalAgentsForOrg(undefined).limit).toBe(5);
    expect(getMaxNonTerminalAgentsForOrg(0.5)).toBe(5);
    expect(getMaxNonTerminalAgentsForOrg(1.5)).toBe(20);
    expect(getMaxNonTerminalAgentsForOrg(15)).toBe(100);
    expect(getMaxNonTerminalAgentsForOrg(150)).toBe(500);
  });
  it("throws on non-finite", () => {
    expect(() => resolveMaxNonTerminalAgentsForOrg(NaN)).toThrow();
    expect(() => resolveMaxNonTerminalAgentsForOrg("bad" as unknown as number)).toThrow();
  });
});
