/**
 * Tests for buildCharacterFromConfig() — focused on agentEntry.settings
 * flow-through into Character.settings.
 *
 * Plugins read configuration through `runtime.getSetting('SOME_KEY')`. Without
 * the per-agent settings flow-through, the only way to deliver
 * agent-scoped configuration to those plugins is environment variables behind
 * a hard-coded allowlist (GETSETTING_ENV_ALLOWLIST). This test pins the
 * intended behavior: keys placed in `agents.list[0].settings` must end up on
 * `character.settings`.
 */

import { describe, it, expect } from "vitest";
import { buildCharacterFromConfig } from "./eliza";
import type { ElizaConfig } from "@elizaos/shared";

function baseConfig(overrides: Partial<ElizaConfig["agents"]> = {}): ElizaConfig {
  return {
    agents: {
      list: [
        {
          id: "main",
          name: "TestAgent",
          ...overrides,
        },
      ],
    },
  } as unknown as ElizaConfig;
}

describe("buildCharacterFromConfig — agentEntry.settings flow-through", () => {
  it("preserves string-valued agent entry settings on character.settings", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "main",
            name: "TestAgent",
            settings: {
              DISCORD_AUTO_REPLY: "false",
              SOME_FEATURE_FLAG: "true",
            },
          },
        ],
      },
    } as unknown as ElizaConfig);

    expect(character.settings?.DISCORD_AUTO_REPLY).toBe("false");
    expect(character.settings?.SOME_FEATURE_FLAG).toBe("true");
  });

  it("does not clobber derived base settings with absent agent entry", () => {
    const character = buildCharacterFromConfig(baseConfig());
    // Base settings should still include the derived memory model defaults.
    expect(character.settings?.MEMORY_SUMMARY_MODEL_TYPE).toBeDefined();
    expect(character.settings?.MEMORY_REFLECTION_MODEL_TYPE).toBeDefined();
  });

  it("agent entry settings override derived defaults when both are present", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "main",
            name: "TestAgent",
            settings: {
              MEMORY_SUMMARY_MODEL_TYPE: "TEXT_LARGE",
            },
          },
        ],
      },
    } as unknown as ElizaConfig);

    expect(character.settings?.MEMORY_SUMMARY_MODEL_TYPE).toBe("TEXT_LARGE");
    // Other derived defaults remain intact.
    expect(character.settings?.MEMORY_REFLECTION_MODEL_TYPE).toBeDefined();
  });

  it("ignores undefined-valued keys (treated as opt-out)", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "main",
            name: "TestAgent",
            settings: {
              DEFINED_KEY: "yes",
              UNDEFINED_KEY: undefined,
            } as Record<string, string | undefined>,
          },
        ],
      },
    } as unknown as ElizaConfig);

    expect(character.settings?.DEFINED_KEY).toBe("yes");
    expect("UNDEFINED_KEY" in (character.settings ?? {})).toBe(false);
  });

  it("rejects non-object settings without throwing", () => {
    expect(() =>
      buildCharacterFromConfig({
        agents: {
          list: [
            {
              id: "main",
              name: "TestAgent",
              // @ts-expect-error — testing runtime guard for malformed config
              settings: "not-an-object",
            },
          ],
        },
      } as unknown as ElizaConfig),
    ).not.toThrow();
  });

  it("accepts numeric and boolean values", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "main",
            name: "TestAgent",
            settings: {
              POLL_INTERVAL_MS: 30000,
              ENABLE_X: true,
            },
          },
        ],
      },
    } as unknown as ElizaConfig);

    expect(character.settings?.POLL_INTERVAL_MS).toBe(30000);
    expect(character.settings?.ENABLE_X).toBe(true);
  });
});
