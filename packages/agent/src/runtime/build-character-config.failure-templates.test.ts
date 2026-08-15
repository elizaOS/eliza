/**
 * Closes the loop between the shipped `eliza` preset's in-character failure
 * replies and the runtime that reads them: `buildCharacterFromConfig` must copy
 * `StylePreset.templates` onto `Character.templates`, because that record is
 * the only thing `DefaultMessageService` consults when every model call has
 * already failed.
 *
 * Companion suites:
 *   - packages/shared/src/character-presets.failure-templates.test.ts (which
 *     strings the preset ships)
 *   - packages/core/src/services/message.character-failure-templates.test.ts
 *     (that the runtime renders them)
 */
import { resolveStylePresetById, setDefaultAgentName } from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { buildCharacterFromConfig } from "./build-character-config.ts";

/** The exact keys the runtime reads, one per failure classification. */
const FAILURE_TEMPLATE_KEYS = [
  "authFailedReply",
  "insufficientCreditsReply",
  "noModelProviderReply",
  "rateLimitedReply",
  "transientFailureReply",
] as const;

function configForPreset(presetId: string, agentName?: string): ElizaConfig {
  return {
    ui: { presetId },
    agents: {
      list: [{ id: "default", ...(agentName ? { name: agentName } : {}) }],
    },
  } as unknown as ElizaConfig;
}

afterEach(() => {
  setDefaultAgentName(null);
});

describe("failure templates flow from the eliza preset into the Character", () => {
  it("copies every failure template the preset ships", () => {
    const preset = resolveStylePresetById("eliza");
    const character = buildCharacterFromConfig(configForPreset("eliza"));

    expect(preset?.templates).toBeDefined();
    for (const key of FAILURE_TEMPLATE_KEYS) {
      expect(character.templates?.[key]).toBe(preset?.templates?.[key]);
      expect(typeof character.templates?.[key]).toBe("string");
    }
  });

  it("resolves the preset by avatarIndex too, not only by explicit presetId", () => {
    // The desktop app persists ui.avatarIndex on some paths; the templates must
    // not depend on which of the three resolvers matched.
    const character = buildCharacterFromConfig({
      ui: { avatarIndex: 1 },
      agents: { list: [{ id: "default" }] },
    } as unknown as ElizaConfig);

    expect(character.templates?.transientFailureReply).toBe(
      resolveStylePresetById("eliza")?.templates?.transientFailureReply,
    );
  });

  it("keeps the templates after a white-label rename of the default persona", () => {
    // setDefaultAgentName() rebrands the default preset for white-label apps.
    // Failure replies deliberately avoid the agent's own name, so the rebrand
    // must keep them intact rather than dropping to framework text.
    setDefaultAgentName("Nyx");
    const character = buildCharacterFromConfig(configForPreset("eliza", "Nyx"));

    expect(character.name).toBe("Nyx");
    for (const key of FAILURE_TEMPLATE_KEYS) {
      expect(character.templates?.[key]).toBeTruthy();
      expect(String(character.templates?.[key])).not.toMatch(/\bEliza\b/);
    }
  });

  it("leaves templates empty for a preset that ships none", () => {
    // The other eight presets are a deliberate follow-up. They must fall
    // through to the framework defaults, not inherit eliza's voice.
    const character = buildCharacterFromConfig(configForPreset("ryu", "Ryu"));

    expect(character.name).toBe("Ryu");
    expect(character.templates).toEqual({});
  });

  it("leaves templates empty when no preset matches the configured name", () => {
    const character = buildCharacterFromConfig(
      configForPreset("", "Totally Custom Agent"),
    );

    expect(character.templates).toEqual({});
  });

  it("does not alias the bundled preset's template object", () => {
    // Two runtimes built from the same preset must not share one mutable
    // record — a per-agent edit would otherwise rewrite the bundled persona
    // for every other agent in the process.
    const first = buildCharacterFromConfig(configForPreset("eliza"));
    const second = buildCharacterFromConfig(configForPreset("eliza"));

    expect(first.templates).not.toBe(second.templates);
    expect(first.templates).toEqual(second.templates);
  });

  it("carries no handlebars placeholders into the built character", () => {
    // bio/system are templated with {{name}}; the failure replies are NOT
    // (the runtime emits them verbatim), so a placeholder would reach the user.
    const character = buildCharacterFromConfig(configForPreset("eliza"));

    for (const key of FAILURE_TEMPLATE_KEYS) {
      expect(String(character.templates?.[key])).not.toMatch(/\{\{/);
    }
    // Premise check: the same character DOES still carry {{name}} elsewhere,
    // so the assertion above is meaningful rather than vacuous.
    expect(JSON.stringify(character.bio)).toMatch(/\{\{name\}\}/);
  });
});
