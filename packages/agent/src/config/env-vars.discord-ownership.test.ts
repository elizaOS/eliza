/**
 * Unit tests for Discord ownership and DM-policy projection in
 * collectConnectorEnvVars. Covers the ELIZA_DISCORD_OWNER_USER_IDS_JSON JSON
 * array contract (must not comma-join) and DISCORD_DM_POLICY /
 * DISCORD_ALLOW_FROM mapping. Deterministic pure-function harness.
 */
import { describe, expect, it } from "vitest";
import { CONNECTOR_ENV_MAP, collectConnectorEnvVars } from "./env-vars.ts";
import type { ElizaConfig } from "./types.ts";

describe("CONNECTOR_ENV_MAP.discord ownership and DM fields", () => {
  it("maps dmPolicy, allowFrom, and ownerUserIdsJson to the plugin env keys", () => {
    expect(CONNECTOR_ENV_MAP.discord.dmPolicy).toBe("DISCORD_DM_POLICY");
    expect(CONNECTOR_ENV_MAP.discord.allowFrom).toBe("DISCORD_ALLOW_FROM");
    expect(CONNECTOR_ENV_MAP.discord.ownerUserIdsJson).toBe(
      "ELIZA_DISCORD_OWNER_USER_IDS_JSON",
    );
  });
});

describe("collectConnectorEnvVars discord ownership and DM policy", () => {
  it("projects dmPolicy and allowFrom string fields", () => {
    const cfg = {
      connectors: {
        discord: {
          token: "bot-token",
          dmPolicy: "allowlist",
          allowFrom: "111111111111111111, 222222222222222222",
        },
      },
    } as ElizaConfig;

    const env = collectConnectorEnvVars(cfg);
    expect(env.DISCORD_API_TOKEN).toBe("bot-token");
    expect(env.DISCORD_DM_POLICY).toBe("allowlist");
    expect(env.DISCORD_ALLOW_FROM).toBe(
      "111111111111111111, 222222222222222222",
    );
  });

  it("comma-joins allowFrom arrays (plugin env is comma-separated)", () => {
    const cfg = {
      connectors: {
        discord: {
          token: "bot-token",
          allowFrom: ["111111111111111111", "222222222222222222"],
        },
      },
    } as ElizaConfig;

    const env = collectConnectorEnvVars(cfg);
    expect(env.DISCORD_ALLOW_FROM).toBe(
      "111111111111111111,222222222222222222",
    );
  });

  it("JSON-stringifies ownerUserIds arrays for ELIZA_DISCORD_OWNER_USER_IDS_JSON", () => {
    const cfg = {
      connectors: {
        discord: {
          token: "bot-token",
          ownerUserIds: ["111111111111111111", "222222222222222222"],
        },
      },
    } as ElizaConfig;

    const env = collectConnectorEnvVars(cfg);
    expect(env.ELIZA_DISCORD_OWNER_USER_IDS_JSON).toBe(
      JSON.stringify(["111111111111111111", "222222222222222222"]),
    );
    // Must not be the comma-joined form parseDiscordOwnerUserIds rejects.
    expect(env.ELIZA_DISCORD_OWNER_USER_IDS_JSON).not.toBe(
      "111111111111111111,222222222222222222",
    );
  });

  it("passes through ownerUserIdsJson strings unchanged", () => {
    const raw = '["111111111111111111"]';
    const cfg = {
      connectors: {
        discord: {
          token: "bot-token",
          ownerUserIdsJson: raw,
        },
      },
    } as ElizaConfig;

    const env = collectConnectorEnvVars(cfg);
    expect(env.ELIZA_DISCORD_OWNER_USER_IDS_JSON).toBe(raw);
  });

  it("omits empty ownership and policy fields", () => {
    const cfg = {
      connectors: {
        discord: {
          token: "bot-token",
          dmPolicy: "  ",
          allowFrom: [],
          ownerUserIds: [],
          ownerUserIdsJson: "",
        },
      },
    } as ElizaConfig;

    const env = collectConnectorEnvVars(cfg);
    expect(env.DISCORD_API_TOKEN).toBe("bot-token");
    expect(env.DISCORD_DM_POLICY).toBeUndefined();
    expect(env.DISCORD_ALLOW_FROM).toBeUndefined();
    expect(env.ELIZA_DISCORD_OWNER_USER_IDS_JSON).toBeUndefined();
  });
});
