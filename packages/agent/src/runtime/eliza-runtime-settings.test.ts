/**
 * Runtime settings projection coverage for cold boot and hot reload. The test
 * pins the persisted config fields plugins read through `runtime.getSetting()`,
 * especially connector credentials saved through chat/settings before a
 * runtime rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { buildRuntimeSettingsProjection } from "./runtime-settings.ts";

const ENV_KEYS = ["SECRET_SALT"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SECRET_SALT = "salt-runtime";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildRuntimeSettingsProjection", () => {
  it("projects connector config and startup-only settings for runtime rebuilds", () => {
    const config = {
      env: {
        vars: {
          OPENAI_API_KEY: "openai-key",
          EVM_PRIVATE_KEY: "blocked-wallet-secret",
          GENERIC_PASSWORD: "blocked-password",
        },
      },
      connectors: {
        discord: {
          token: "discord-token",
          botToken: "discord-bot-token",
          applicationId: "discord-app",
        },
        telegram: {
          botToken: "telegram-token",
        },
        whatsapp: {
          authDir: "/tmp/whatsapp-auth",
          allowFrom: ["+15551234567"],
          groupAllowFrom: ["family"],
        },
      },
      agents: {
        defaults: {
          adminEntityId: " owner-entity ",
          ownerContacts: {
            imessage: { platform: "imessage", handle: "+15550001111" },
          },
        },
      },
      roles: {
        connectorAdmins: { imessage: ["owner-entity"] },
      },
      skills: {
        allowBundled: ["calendar"],
        denyBundled: ["browser"],
        load: { extraDirs: ["/custom/skills"] },
      },
      features: { vision: false },
    } as ElizaConfig;

    const settings = buildRuntimeSettingsProjection(config, {
      preferredProviderId: "openai",
      visionModeSetting: "OFF",
      managedSkillsDir: "/state/skills",
      bundledSkillsDir: "/bundled/skills",
      workspaceSkillsDir: "/workspace/skills",
      walletSettings: {
        SOLANA_RPC_URL: "https://solana.example/rpc",
        SOLANA_NO_ACTIONS: "true",
        SOLANA_PUBLIC_KEY: "solana-public",
        WALLET_PUBLIC_KEY: "solana-public",
      },
    });

    expect(settings).toMatchObject({
      VALIDATION_LEVEL: "fast",
      ENCRYPTION_SALT: "salt-runtime",
      OPENAI_API_KEY: "openai-key",
      DISCORD_API_TOKEN: "discord-token",
      DISCORD_BOT_TOKEN: "discord-token",
      DISCORD_APPLICATION_ID: "discord-app",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      WHATSAPP_AUTH_DIR: "/tmp/whatsapp-auth",
      WHATSAPP_ALLOW_FROM: "+15551234567",
      WHATSAPP_GROUP_ALLOW_FROM: "family",
      MODEL_PROVIDER: "openai",
      VISION_MODE: "OFF",
      SOLANA_RPC_URL: "https://solana.example/rpc",
      SOLANA_NO_ACTIONS: "true",
      SOLANA_PUBLIC_KEY: "solana-public",
      WALLET_PUBLIC_KEY: "solana-public",
      ELIZA_ADMIN_ENTITY_ID: "owner-entity",
      ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify({
        imessage: ["owner-entity"],
      }),
      SKILLS_ALLOWLIST: "calendar",
      SKILLS_DENYLIST: "browser",
      SKILLS_DIR: "/state/skills",
      BUNDLED_SKILLS_DIRS: "/bundled/skills",
      WORKSPACE_SKILLS_DIR: "/workspace/skills",
      EXTRA_SKILLS_DIRS: "/custom/skills",
      DISABLE_IMAGE_DESCRIPTION: "true",
    });
    expect(settings.ELIZA_OWNER_CONTACTS_JSON).toBe(
      JSON.stringify({
        imessage: { platform: "imessage", handle: "+15550001111" },
      }),
    );
    expect(settings.EVM_PRIVATE_KEY).toBeUndefined();
    expect(settings.GENERIC_PASSWORD).toBeUndefined();
  });
});
