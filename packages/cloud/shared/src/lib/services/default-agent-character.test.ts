/**
 * Surface under test: the default persona a persona-less cloud create seeds into
 * `agent_sandboxes.agent_config`, proven at the boundaries that actually consume
 * it rather than only at the seed itself.
 *
 * Deterministic and self-contained: the seed and the shared-turn projection are
 * pure, and the turn boundary captures the character passed to AgentRuntime.
 * No network, database, or live model is involved.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getDefaultStylePreset } from "@elizaos/shared";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { buildCloudElizaPersona } from "../utils/cloud-eliza-persona";
import {
  agentConfigHasCharacter,
  buildDefaultAgentCharacterConfig,
  withDefaultAgentCharacter,
} from "./default-agent-character";
import { projectSharedAgentCharacter } from "./shared-runtime/shared-agent-character";
import { buildWarmClaimCharacterPayload } from "./warm-claim-character-push";

let capturedSystem: string | undefined;

mock.module("../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("./shared-runtime/shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    capturedSystem = (input.character as { system: string }).system;
    return {
      reply: "ok reply",
      history: [],
      model: String(input.model),
      degraded: false,
    };
  },
  runSharedElizaRuntimeTurnStream: () => {
    throw new Error("streaming is not exercised by this suite");
  },
}));

const { runSharedAgentTurn } = await import("./shared-runtime/run-shared-agent-turn");

/** The row a persona-less create writes, as assembled by the create funnel. */
function seededAgent(agentName: string): AgentSandbox {
  return {
    id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: agentName,
    agent_config: withDefaultAgentCharacter({}),
    character_id: null,
  } as AgentSandbox;
}

beforeEach(() => {
  capturedSystem = undefined;
});

describe("default agent character seed", () => {
  test("projects the canonical cloud persona onto the flat agent_config keys", () => {
    const preset = buildCloudElizaPersona();
    const seed = buildDefaultAgentCharacterConfig();

    expect(getDefaultStylePreset().id).toBe("eliza");
    expect(seed.system).toBe(preset.system);
    expect(seed.bio).toEqual(preset.bio);
    expect(seed.adjectives).toEqual(preset.adjectives);
    expect(seed.topics).toEqual(preset.topics);
    expect(seed.style).toEqual(preset.style);
    expect(seed.postExamples).toEqual(preset.postExamples);
    expect(seed.templates).toEqual(preset.templates);
    // Flat keys only: the container env loader, the warm-claim push, and the
    // first-boot bootstrap agent all read agent_config at the top level.
    expect(Object.keys(seed).sort()).toEqual([
      "adjectives",
      "bio",
      "messageExamples",
      "postExamples",
      "style",
      "system",
      "templates",
      "topics",
    ]);
  });

  test("emits message examples in the strict group form the character schema accepts", () => {
    const preset = buildCloudElizaPersona();
    const seed = buildDefaultAgentCharacterConfig();
    const groups = seed.messageExamples as Array<{
      examples: Array<{ name: string; content: { text: string } }>;
    }>;

    expect(groups).toHaveLength(preset.messageExamples.length);
    expect(groups[0]?.examples[0]).toEqual({
      name: preset.messageExamples[0]?.[0]?.user as string,
      content: preset.messageExamples[0]?.[0]?.content as { text: string },
    });
    // The legacy `[[{user, content}]]` form is dropped by the warm-claim push.
    expect(groups.every((group) => Array.isArray(group.examples))).toBe(true);
  });

  test("keeps {{name}} tokens so a later rename keeps propagating", () => {
    // The persona ships tokenized (`{{name}}`) and the seed must carry the
    // tokens verbatim rather than expanding them at create time. Only the
    // system prompt is guaranteed to carry a token; other fields follow the
    // catalog's own copy, which the equality assertions above already pin.
    const seed = buildDefaultAgentCharacterConfig();
    expect(buildCloudElizaPersona().system).toContain("{{name}}");
    expect(seed.system as string).toContain("{{name}}");
  });

  test("never overwrites a persona the caller already supplied", () => {
    expect(withDefaultAgentCharacter({ system: "mine" })).toEqual({ system: "mine" });
    expect(withDefaultAgentCharacter({ bio: ["mine"] })).toEqual({ bio: ["mine"] });
    expect(withDefaultAgentCharacter({ prompt: "mine" })).toEqual({ prompt: "mine" });
    expect(withDefaultAgentCharacter({ character: { system: "mine" } })).toEqual({
      character: { system: "mine" },
    });

    // Non-persona config is preserved alongside the seed.
    const seeded = withDefaultAgentCharacter({ tokenTicker: "ABC" });
    expect(seeded.tokenTicker).toBe("ABC");
    expect(seeded.system).toBe(buildDefaultAgentCharacterConfig().system);
  });

  test("completes the legacy first-run request that supplied only the default preset bio", () => {
    const legacyBio = [...getDefaultStylePreset().bio];
    const seeded = withDefaultAgentCharacter({ bio: legacyBio });
    const canonical = buildCloudElizaPersona();

    expect(seeded.system).toBe(canonical.system);
    expect(seeded.bio).toEqual(canonical.bio);
    expect(seeded.style).toEqual(canonical.style);
  });

  test("agentConfigHasCharacter distinguishes a persona from unrelated config", () => {
    expect(agentConfigHasCharacter(null)).toBe(false);
    expect(agentConfigHasCharacter({})).toBe(false);
    expect(agentConfigHasCharacter({ plugins: [] })).toBe(false);
    expect(agentConfigHasCharacter({ character: { avatarUrl: "x" } })).toBe(false);
    expect(agentConfigHasCharacter({ system: "x" })).toBe(true);
    expect(agentConfigHasCharacter({ character: { bio: ["x"] } })).toBe(true);
  });

  test("treats a blank persona field as absent, matching every reader", () => {
    // The readers resolve "" / ["  "] to their stub, so these must still seed.
    expect(agentConfigHasCharacter({ system: "   " })).toBe(false);
    expect(agentConfigHasCharacter({ bio: [] })).toBe(false);
    expect(agentConfigHasCharacter({ bio: ["  "] })).toBe(false);
    expect(withDefaultAgentCharacter({ system: "" }).system).toBe(
      buildDefaultAgentCharacterConfig().system,
    );
  });

  test("returns a fresh projection so a stored row never aliases the catalog", () => {
    const first = buildDefaultAgentCharacterConfig();
    const second = buildDefaultAgentCharacterConfig();
    expect(first).toEqual(second);
    expect(first.bio).not.toBe(second.bio);
    expect(first.style).not.toBe(second.style);
  });
});

describe("a newly created cloud agent's character", () => {
  test("shared tier: the turn's system prompt is the preset persona under the agent's own name", async () => {
    const agent = seededAgent("Nyx");
    const character = projectSharedAgentCharacter(agent);

    expect(character.name).toBe("Nyx");
    expect(character.system).toBe(buildCloudElizaPersona().system);
    expect(character.bio?.length).toBeGreaterThan(0);
    expect(character.adjectives).toEqual(buildCloudElizaPersona().adjectives);
    expect(character.topics).toEqual(buildCloudElizaPersona().topics);
    expect(character.style).toEqual(buildCloudElizaPersona().style);
    expect(character.messageExamples?.length).toBeGreaterThan(0);
    expect(character.templates).toEqual(buildCloudElizaPersona().templates);
    expect(character.system).not.toBe("You are Nyx, a helpful assistant.");

    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "who are you?",
    });

    expect(result.reply).toBe("ok reply");
    expect(capturedSystem).toBeDefined();
    // The rendered prompt carries the persona with tokens resolved — a literal
    // "{{name}}" reaching the model is the failure this asserts against. The
    // expected copy is derived from the canonical persona itself so a catalog
    // copy-edit cannot silently invalidate this test.
    expect(capturedSystem).not.toContain("{{name}}");
    expect(capturedSystem).toContain(
      buildCloudElizaPersona().system.split("{{name}}").join("Nyx").trim(),
    );
    expect(capturedSystem).not.toBe("You are Nyx, a helpful assistant.");
  });

  test("dedicated tier: the warm-claim push carries the persona instead of a bare name", () => {
    const agent = seededAgent("Nyx");
    const payload = buildWarmClaimCharacterPayload(agent.agent_config, agent.agent_name);

    expect(payload).not.toBeNull();
    expect(payload?.name).toBe("Nyx");
    const persona = buildCloudElizaPersona();
    expect(payload?.system).toBe(persona.system);
    expect(payload?.bio).toEqual(persona.bio);
    expect(payload?.style).toEqual(persona.style);
    expect(payload?.topics).toEqual(persona.topics);
    expect(payload?.adjectives).toEqual(persona.adjectives);
    expect(payload?.postExamples).toEqual(persona.postExamples);
    expect(Array.isArray(payload?.messageExamples)).toBe(true);
  });
});
