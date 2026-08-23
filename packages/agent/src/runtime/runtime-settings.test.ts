/**
 * Unit tests for runtime settings projection and env key security filtering.
 */

import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.js";
import {
  buildRuntimeSettingsProjection,
  isEnvKeyAllowedForForwarding,
} from "./runtime-settings.js";

describe("runtime-settings", () => {
  it("filters sensitive environment variable keys in isEnvKeyAllowedForForwarding", () => {
    // Sensitive keys blocked
    expect(isEnvKeyAllowedForForwarding("ALLOW_NO_DATABASE")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("ETH_PRIVATE_KEY")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("EVM_WALLET_KEY")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("SOLANA_KEYPAIR")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("DATABASE_PASSWORD")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("JWT_SECRET")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("WALLET_SEED_PHRASE")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("GITHUB_ACCESS_TOKEN")).toBe(false);
    expect(isEnvKeyAllowedForForwarding("ELIZAOS_CLOUD_API_KEY")).toBe(false);

    // Safe plugin API keys allowed
    expect(isEnvKeyAllowedForForwarding("ANTHROPIC_API_KEY")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("OPENAI_API_KEY")).toBe(true);
    expect(isEnvKeyAllowedForForwarding("TELEGRAM_BOT_TOKEN")).toBe(true);
  });

  it("builds runtime settings projection from ElizaConfig and options", () => {
    const config: ElizaConfig = {
      agents: {
        defaults: {
          adminEntityId: "admin-uuid",
          ownerContacts: [{ id: "contact-1", name: "Alice" }],
        },
      },
      skills: {
        allowBundled: ["math", "search"],
        denyBundled: ["dangerous"],
      },
      features: {
        vision: false,
      },
    };

    const projection = buildRuntimeSettingsProjection(config, {
      preferredProviderId: "anthropic",
      managedSkillsDir: "/path/to/skills",
      env: {
        SECRET_SALT: "salt123",
        EMBEDDING_PROVIDER: "OPENAI",
      },
    });

    expect(projection.VALIDATION_LEVEL).toBe("fast");
    expect(projection.ENCRYPTION_SALT).toBe("salt123");
    expect(projection.EMBEDDING_PROVIDER).toBe("openai");
    expect(projection.MODEL_PROVIDER).toBe("anthropic");
    expect(projection.ELIZA_ADMIN_ENTITY_ID).toBe("admin-uuid");
    expect(projection.SKILLS_ALLOWLIST).toBe("math,search");
    expect(projection.SKILLS_DENYLIST).toBe("dangerous");
    expect(projection.SKILLS_DIR).toBe("/path/to/skills");
    expect(projection.DISABLE_IMAGE_DESCRIPTION).toBe("true");
  });
});
