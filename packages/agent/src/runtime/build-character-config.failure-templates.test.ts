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
    // Failure replies deliberately avoid the agent's own PERSONA name, so the
    // rebrand must keep them intact rather than dropping to framework text.
    // References to the "Eliza Cloud" PRODUCT (and its ELIZAOS_CLOUD_API_KEY
    // env var) are functional setup guidance, not persona voice, and are
    // allowed to survive the rename.
    setDefaultAgentName("Nyx");
    const character = buildCharacterFromConfig(configForPreset("eliza", "Nyx"));

    expect(character.name).toBe("Nyx");
    for (const key of FAILURE_TEMPLATE_KEYS) {
      expect(character.templates?.[key]).toBeTruthy();
      expect(String(character.templates?.[key])).not.toMatch(/\bEliza\b(?!\s*Cloud)/);
    }
  });

  it("leaves templates empty for a preset that ships none", () => {
    // The other eight presets are a deliberate follow-up. They must fall
    // through to the framework defaults, not inherit eliza's voice.
    const character = buildCharacterFromConfig(configForPreset("ryu", "Ryu"));

    expect(character.name).toBe("Ryu");
    expect(character.templates).toEqual({});
  });

  it("inherits the default preset's templates when no preset matches the configured name (#17026)", () => {
    // A custom-named agent with no explicit replacement system prompt inherits
    // the DEFAULT preset (its failure replies avoid the persona name, so they
    // read correctly for any agent name). Only an explicit `system` opts out.
    const character = buildCharacterFromConfig(
      configForPreset("", "Totally Custom Agent"),
    );

    expect(character.templates).toEqual({
      ...resolveStylePresetById("eliza")?.templates,
    });
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
      // Truthiness first so `String(undefined)` can never make the
      // no-placeholder assertion pass vacuously.
      expect(character.templates?.[key]).toBeTruthy();
      expect(String(character.templates?.[key])).not.toMatch(/\{\{/);
    }
  });
});
