// Exercises eliza agent config behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  AGENT_MANAGED_DISCORD_KEY,
  type ManagedAgentDiscordBinding,
  readManagedAgentDiscordBinding,
  reusesExistingElizaCharacter,
  stripReservedElizaConfigKeys,
  withManagedAgentDiscordBinding,
  withReusedElizaCharacterOwnership,
} from "./eliza-agent-config";

/**
 * Managed agent config. The security property: a user-supplied agentConfig can
 * never carry reserved `__agent*` keys through — stripReservedElizaConfigKeys
 * removes them so a caller can't forge ownership/managed-binding state.
 */

describe("stripReservedElizaConfigKeys", () => {
  test("removes any __agent* key (case-insensitive), keeps the rest", () => {
    const out = stripReservedElizaConfigKeys({
      foo: 1,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "forged",
      [AGENT_MANAGED_DISCORD_KEY]: { mode: "cloud-managed" },
      __AGENTsomething: true,
    });
    expect(out).toEqual({ foo: 1 });
    expect(stripReservedElizaConfigKeys(null)).toEqual({});
    expect(stripReservedElizaConfigKeys({ bar: 2 })).toEqual({ bar: 2 });
  });
});

describe("character ownership", () => {
  test("withReusedElizaCharacterOwnership strips forgeries then sets the flag", () => {
    const out = withReusedElizaCharacterOwnership({
      foo: 1,
      [AGENT_CHARACTER_OWNERSHIP_KEY]: "forged",
    });
    expect(out.foo).toBe(1);
    expect(reusesExistingElizaCharacter(out)).toBe(true);
    expect(reusesExistingElizaCharacter({})).toBe(false);
    expect(reusesExistingElizaCharacter({ [AGENT_CHARACTER_OWNERSHIP_KEY]: "other" })).toBe(false);
  });
});

describe("managed Discord binding round-trip", () => {
  const binding: ManagedAgentDiscordBinding = {
    mode: "cloud-managed",
    guildId: "g1",
    guildName: "Guild",
    adminDiscordUserId: "u1",
    adminDiscordUsername: "admin",
    adminElizaUserId: "e1",
    connectedAt: "2026-06-23T00:00:00.000Z",
  };

  test("write then read returns the normalized binding", () => {
    const cfg = withManagedAgentDiscordBinding({}, binding);
    expect(readManagedAgentDiscordBinding(cfg)).toMatchObject({
      mode: "cloud-managed",
      guildId: "g1",
      adminElizaUserId: "e1",
    });
  });

  test("read returns null when required fields are missing", () => {
    expect(readManagedAgentDiscordBinding(null)).toBeNull();
    expect(
      readManagedAgentDiscordBinding({
        [AGENT_MANAGED_DISCORD_KEY]: { guildId: "g1" },
      }),
    ).toBeNull();
  });
});
