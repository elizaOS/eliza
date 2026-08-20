/**
 * Pins the in-character failure replies shipped by the default `eliza` persona.
 *
 * Without these the runtime falls back to voice-neutral framework strings
 * ("Something went wrong on my end. Please try again."), so the persona breaks
 * exactly when the user is already having a bad time. These tests assert both
 * halves of "genuinely useful, still in voice": the key set the runtime
 * actually reads, and the voice constraints eliza's own style rules impose.
 *
 * The runtime half of the contract (that these keys are read at all) lives in
 * `packages/core/src/services/message.character-failure-templates.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { CHARACTER_DEFINITIONS } from "./character-presets.characters.js";
import {
  getStylePresets,
  resolveStylePresetById,
} from "./character-presets.js";
import {
  CHARACTER_LANGUAGES,
  type CharacterFailureTemplates,
} from "./contracts/first-run-options.js";

/**
 * The exact keys `DefaultMessageService` reads, one per failure
 * classification. Typed against the shared contract so a rename breaks the
 * build rather than silently reverting eliza to framework text.
 */
const FAILURE_TEMPLATE_KEYS = [
  "authFailedReply",
  "insufficientCreditsReply",
  "noModelProviderReply",
  "rateLimitedReply",
  "transientFailureReply",
] as const satisfies ReadonlyArray<keyof CharacterFailureTemplates>;

const elizaDefinition = CHARACTER_DEFINITIONS.find(
  (definition) => definition.id === "eliza",
);

describe("eliza preset failure templates", () => {
  it("ships every failure key the runtime reads", () => {
    const templates = elizaDefinition?.templates;
    expect(templates).toBeDefined();
    expect(Object.keys(templates ?? {}).sort()).toEqual(
      [...FAILURE_TEMPLATE_KEYS].sort(),
    );
  });

  it("survives preset resolution in every supported language", () => {
    // Failure replies are language-independent by construction (the runtime
    // emits them verbatim, exactly like the English framework strings they
    // replace), so resolving a non-English variant must not drop them.
    for (const language of CHARACTER_LANGUAGES) {
      const preset = resolveStylePresetById("eliza", language);
      expect(preset?.templates).toEqual(elizaDefinition?.templates);
    }
  });

  it("exposes the templates through the catalog builder too", () => {
    const preset = getStylePresets("en").find((entry) => entry.id === "eliza");
    expect(preset?.templates).toEqual(elizaDefinition?.templates);
  });

  it("does not share a mutable object with the definition", () => {
    // resolveCharacterVariant copies every other field; a shared reference here
    // would let one consumer's edit rewrite the bundled persona process-wide.
    const preset = resolveStylePresetById("eliza");
    expect(preset?.templates).not.toBe(elizaDefinition?.templates);
  });

  describe.each(FAILURE_TEMPLATE_KEYS)("%s", (key) => {
    const text = () => elizaDefinition?.templates?.[key] ?? "";

    it("is non-empty and brief enough to read in a chat bubble", () => {
      expect(text().length).toBeGreaterThan(20);
      // The runtime truncates at 2000 chars; eliza's style is "brief is
      // usually better", so stay far under it.
      expect(text().length).toBeLessThanOrEqual(240);
    });

    it("contains no handlebars placeholder", () => {
      // These strings are emitted verbatim — no template pass runs on them —
      // so a {{name}} would be shown to the user literally.
      expect(text()).not.toMatch(/\{\{/);
    });

    it("carries no em-dash, en-dash, or emoji", () => {
      expect(text()).not.toMatch(/[—–]/);
      expect(text()).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("does not hardcode the agent's name", () => {
      // The default persona is renameable via setDefaultAgentName() for
      // white-label apps, so naming "Eliza" here would contradict the rebrand.
      // "eliza cloud" is the product a user signs into, not the agent's name,
      // so it is allowed — the framework default names it too.
      const withoutProductNames = text()
        .toLowerCase()
        .replace(/eliza cloud/g, "")
        .replace(/elizaos_cloud_api_key/g, "");
      expect(withoutProductNames).not.toContain("eliza");
    });

    it("stays in eliza's non-corporate register", () => {
      expect(text().toLowerCase()).not.toMatch(
        /\b(?:apolog|inconvenience|kindly|please note|at this time|we are experiencing)\b/,
      );
    });

    it("tells the user what to do next", () => {
      // "Genuinely useful, not cute": every reply must carry a remedy, not
      // just an announcement that something failed.
      expect(text().toLowerCase()).toMatch(
        /\b(?:try|retry|send|check|fix|add|raise|set|sign in|wait)\b/,
      );
    });
  });

  it("says the credits case is not fixed by waiting, and the rate-limit case is", () => {
    // The two are easy to confuse and the remedies are opposite: telling a
    // drained account to "try again" is the exact failure this replaces.
    const templates = elizaDefinition?.templates ?? {};
    expect(templates.insufficientCreditsReply?.toLowerCase()).toMatch(
      /credits/,
    );
    expect(templates.insufficientCreditsReply?.toLowerCase()).toMatch(
      /won't fix|add credits|raise the quota/,
    );
    expect(templates.rateLimitedReply?.toLowerCase()).toMatch(
      /throttl|rate|few seconds/,
    );
    expect(templates.rateLimitedReply?.toLowerCase()).not.toMatch(/credits/);
  });

  it("distinguishes an authorization failure from a temporary rate limit", () => {
    const templates = elizaDefinition?.templates ?? {};
    const authFailure = templates.authFailedReply?.toLowerCase() ?? "";
    const rateLimit = templates.rateLimitedReply?.toLowerCase() ?? "";

    expect(authFailure).toMatch(/account isn't authorized/);
    expect(authFailure).toMatch(/account owner needs to fix/);
    expect(authFailure).toMatch(/before you retry/);
    expect(authFailure).not.toMatch(/right now|in a moment|wait|few seconds/);
    expect(rateLimit).toMatch(/few seconds/);
    expect(rateLimit).not.toMatch(/authoriz|account owner/);
  });

  it("keeps the no-provider reply actionable with real env var names", () => {
    const text = elizaDefinition?.templates?.noModelProviderReply ?? "";
    for (const envKey of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]) {
      expect(text).toContain(envKey);
    }
  });

  it("gives each failure kind a distinct string", () => {
    const values = FAILURE_TEMPLATE_KEYS.map(
      (key) => elizaDefinition?.templates?.[key],
    );
    expect(new Set(values).size).toBe(FAILURE_TEMPLATE_KEYS.length);
  });

  it("leaves the other eight presets on the framework defaults for now", () => {
    // Deliberate scope: only the default persona has authored failure replies.
    // Delete this assertion when the follow-up covers chen/jin/kei/momo/rin/
    // ryu/satoshi/yuki.
    const withTemplates = CHARACTER_DEFINITIONS.filter(
      (definition) => definition.templates !== undefined,
    ).map((definition) => definition.id);
    expect(withTemplates).toEqual(["eliza"]);
  });
});
