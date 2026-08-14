/**
 * Exercises the reserved `__agent*` config namespace end to end with plain
 * fixtures: forge-stripping, character ownership, the Discord/GitHub managed
 * bindings and gateway markers, and the tier-upgrade reattach marker.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  AGENT_MANAGED_DISCORD_GATEWAY_KEY,
  AGENT_MANAGED_DISCORD_KEY,
  AGENT_MANAGED_GITHUB_KEY,
  AGENT_UPGRADED_FROM_KEY,
  type ManagedAgentDiscordBinding,
  type ManagedAgentGithubBinding,
  readManagedAgentDiscordBinding,
  readManagedAgentDiscordGateway,
  readManagedAgentGithubBinding,
  readUpgradedFromAgentId,
  reusesExistingElizaCharacter,
  stripReservedElizaConfigKeys,
  withManagedAgentDiscordBinding,
  withManagedAgentDiscordGateway,
  withManagedAgentGithubBinding,
  withoutManagedAgentDiscordBinding,
  withoutManagedAgentGithubBinding,
  withReusedElizaCharacterOwnership,
} from "./eliza-agent-config";

// The security property under test: a user-supplied agentConfig can never
// carry reserved `__agent*` keys through — stripReservedElizaConfigKeys
// removes them so a caller can't forge ownership/managed-binding/upgrade
// state.

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

  test("drops a forged tier-upgrade marker (create can never accept it from callers)", () => {
    const out = stripReservedElizaConfigKeys({
      keep: true,
      [AGENT_UPGRADED_FROM_KEY]: "attacker-chosen-shared-id",
    });
    expect(out).toEqual({ keep: true });
    expect(readUpgradedFromAgentId(out)).toBeNull();
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

describe("tier-upgrade reattach marker", () => {
  test("readUpgradedFromAgentId returns the recorded shared source id", () => {
    expect(readUpgradedFromAgentId({ [AGENT_UPGRADED_FROM_KEY]: "shared-1" })).toBe("shared-1");
  });

  test("missing, blank, or non-string markers read as null (never a fake id)", () => {
    expect(readUpgradedFromAgentId(undefined)).toBeNull();
    expect(readUpgradedFromAgentId(null)).toBeNull();
    expect(readUpgradedFromAgentId({})).toBeNull();
    expect(readUpgradedFromAgentId({ [AGENT_UPGRADED_FROM_KEY]: "" })).toBeNull();
    expect(readUpgradedFromAgentId({ [AGENT_UPGRADED_FROM_KEY]: "   " })).toBeNull();
    expect(readUpgradedFromAgentId({ [AGENT_UPGRADED_FROM_KEY]: 42 })).toBeNull();
    expect(readUpgradedFromAgentId({ [AGENT_UPGRADED_FROM_KEY]: { id: "x" } })).toBeNull();
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

  test("optional fields survive the round-trip; blank optionals are dropped", () => {
    const cfg = withManagedAgentDiscordBinding(
      {},
      {
        ...binding,
        applicationId: "app-1",
        adminDiscordDisplayName: "Admin D",
        adminDiscordAvatarUrl: "https://cdn.test/a.png",
        botNickname: "Botty",
      },
    );
    expect(readManagedAgentDiscordBinding(cfg)).toMatchObject({
      applicationId: "app-1",
      adminDiscordDisplayName: "Admin D",
      adminDiscordAvatarUrl: "https://cdn.test/a.png",
      botNickname: "Botty",
    });
    const bare = readManagedAgentDiscordBinding(withManagedAgentDiscordBinding({}, binding));
    expect(bare).not.toHaveProperty("applicationId");
    expect(bare).not.toHaveProperty("botNickname");
  });

  test("read returns null when required fields are missing", () => {
    expect(readManagedAgentDiscordBinding(null)).toBeNull();
    expect(
      readManagedAgentDiscordBinding({
        [AGENT_MANAGED_DISCORD_KEY]: { guildId: "g1" },
      }),
    ).toBeNull();
    expect(
      readManagedAgentDiscordBinding({ [AGENT_MANAGED_DISCORD_KEY]: "not-an-object" }),
    ).toBeNull();
  });

  test("a blank connectedAt normalizes to the epoch sentinel", () => {
    const cfg = withManagedAgentDiscordBinding({}, { ...binding, connectedAt: "" });
    expect(readManagedAgentDiscordBinding(cfg)?.connectedAt).toBe(new Date(0).toISOString());
  });

  test("withoutManagedAgentDiscordBinding removes only the binding key", () => {
    const cfg = withManagedAgentDiscordBinding({ keep: 1 }, binding);
    const out = withoutManagedAgentDiscordBinding(cfg);
    expect(out).not.toHaveProperty(AGENT_MANAGED_DISCORD_KEY);
    expect(out.keep).toBe(1);
    expect(withoutManagedAgentDiscordBinding(null)).toEqual({});
  });
});

describe("managed Discord gateway marker", () => {
  test("write then read returns the normalized gateway record", () => {
    const cfg = withManagedAgentDiscordGateway(
      { keep: true },
      { mode: "shared-gateway", createdAt: "2026-06-23T00:00:00.000Z" },
    );
    expect(cfg.keep).toBe(true);
    expect(readManagedAgentDiscordGateway(cfg)).toEqual({
      mode: "shared-gateway",
      createdAt: "2026-06-23T00:00:00.000Z",
    });
  });

  test("the default gateway argument stamps a current timestamp", () => {
    const gateway = readManagedAgentDiscordGateway(withManagedAgentDiscordGateway({}));
    expect(gateway?.mode).toBe("shared-gateway");
    expect(Date.parse(gateway?.createdAt ?? "")).toBeGreaterThan(0);
  });

  test("missing or wrong-mode records read as null; blank createdAt normalizes", () => {
    expect(readManagedAgentDiscordGateway(null)).toBeNull();
    expect(readManagedAgentDiscordGateway({})).toBeNull();
    expect(
      readManagedAgentDiscordGateway({
        [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: { mode: "something-else" },
      }),
    ).toBeNull();
    expect(
      readManagedAgentDiscordGateway({
        [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: { mode: "shared-gateway" },
      })?.createdAt,
    ).toBe(new Date(0).toISOString());
  });
});

describe("managed GitHub binding round-trip", () => {
  const binding: ManagedAgentGithubBinding = {
    mode: "cloud-managed",
    connectionId: "conn-1",
    githubUserId: "12345",
    githubUsername: "octo",
    scopes: ["repo", "read:user"],
    adminElizaUserId: "e1",
    connectedAt: "2026-06-23T00:00:00.000Z",
  };

  test("write then read returns the normalized binding with scopes", () => {
    const cfg = withManagedAgentGithubBinding({}, binding);
    expect(readManagedAgentGithubBinding(cfg)).toMatchObject({
      mode: "cloud-managed",
      connectionId: "conn-1",
      githubUsername: "octo",
      scopes: ["repo", "read:user"],
    });
  });

  test("optional fields, role, and source survive the round-trip", () => {
    const cfg = withManagedAgentGithubBinding(
      {},
      {
        ...binding,
        mode: "shared-owner",
        connectionRole: "owner",
        source: "platform_credentials",
        githubDisplayName: "Octo Cat",
        githubAvatarUrl: "https://cdn.test/octo.png",
        githubEmail: "octo@test.test",
      },
    );
    expect(readManagedAgentGithubBinding(cfg)).toMatchObject({
      mode: "shared-owner",
      connectionRole: "owner",
      source: "platform_credentials",
      githubDisplayName: "Octo Cat",
      githubAvatarUrl: "https://cdn.test/octo.png",
      githubEmail: "octo@test.test",
    });
  });

  test("unknown mode/role/source values normalize instead of passing through", () => {
    const cfg = {
      [AGENT_MANAGED_GITHUB_KEY]: {
        ...binding,
        mode: "evil-mode",
        connectionRole: "root",
        source: "somewhere",
        scopes: "not-an-array",
      },
    };
    const out = readManagedAgentGithubBinding(cfg);
    expect(out?.mode).toBe("cloud-managed");
    expect(out).not.toHaveProperty("connectionRole");
    expect(out).not.toHaveProperty("source");
    expect(out?.scopes).toEqual([]);
  });

  test("read returns null when required fields are missing", () => {
    expect(readManagedAgentGithubBinding(null)).toBeNull();
    expect(
      readManagedAgentGithubBinding({
        [AGENT_MANAGED_GITHUB_KEY]: { connectionId: "conn-1" },
      }),
    ).toBeNull();
  });

  test("withoutManagedAgentGithubBinding removes only the binding key", () => {
    const cfg = withManagedAgentGithubBinding({ keep: 1 }, binding);
    const out = withoutManagedAgentGithubBinding(cfg);
    expect(out).not.toHaveProperty(AGENT_MANAGED_GITHUB_KEY);
    expect(out.keep).toBe(1);
    expect(withoutManagedAgentGithubBinding(undefined)).toEqual({});
  });
});
