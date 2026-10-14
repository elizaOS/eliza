/**
 * MCP kill-switch case-insensitivity.
 *
 * `parseKillSwitch` lowercases every token, and `isKillSwitched` lowercases
 * the catalog id — but the provider slug was compared verbatim. A mixed-case
 * slug (e.g. "Crypto") never matched a kill-switch token, so the switch
 * silently failed to disable that provider.
 */
import { describe, expect, test } from "bun:test";
import {
  isKillSwitched,
  parseKillSwitch,
} from "../src/lib/mcp/integration-catalog";

describe("isKillSwitched provider slug casing", () => {
  const env = { MCP_KILL_SWITCH: "crypto" };

  test("matches a lowercase slug", () => {
    expect(isKillSwitched(env, "other-id", "crypto")).toBe(true);
  });

  test("matches a mixed-case slug", () => {
    expect(isKillSwitched(env, "other-id", "Crypto")).toBe(true);
  });

  test("matches an uppercase slug", () => {
    expect(isKillSwitched(env, "other-id", "CRYPTO")).toBe(true);
  });

  test("matches aliases for a mixed-case slug", () => {
    // "crypto" aliases to "crypto-prices" / "crypto-mcp"; the alias lookup
    // uses the slug as key, so it must be lowercased too.
    const aliasEnv = { MCP_KILL_SWITCH: "crypto-prices" };
    expect(isKillSwitched(aliasEnv, "other-id", "Crypto")).toBe(true);
  });

  test("does not match an unrelated slug", () => {
    expect(isKillSwitched(env, "other-id", "weather")).toBe(false);
    expect(isKillSwitched(env, "other-id", null)).toBe(false);
  });

  test("parseKillSwitch lowercases tokens", () => {
    expect([...parseKillSwitch("Crypto, WEATHER").ids]).toEqual([
      "crypto",
      "weather",
    ]);
  });
});
