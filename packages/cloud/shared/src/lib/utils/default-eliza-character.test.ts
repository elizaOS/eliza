// Exercises default eliza character behavior with deterministic cloud-shared lib fixtures.
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import defaultAgent from "../eliza/agent";
import { getConditionalPlugins } from "../eliza/agent-mode-types";
import { WebSearchService } from "../eliza/plugin-web-search/src/services/searchService";
import { getDefaultElizaCharacterData } from "./default-eliza-character";

/**
 * The default Eliza character is what every new cloud signup gets. Its persona
 * promises (bio), behavioral rules (system), examples, and settings must stay
 * coherent with each other and with what the agent loader actually wires up —
 * a bio that promises months-later memory next to a rule that forbids recalling
 * anything outside the current conversation ships a self-contradicting agent,
 * and a settings key that loads a plugin whose service can never start ships
 * an error on every runtime creation.
 */

describe("getDefaultElizaCharacterData", () => {
  const character = getDefaultElizaCharacterData();

  test("memory honesty rule is scoped to context, not just the current conversation", () => {
    // bio[0] promises long-term memory; the honesty rule must allow recall from
    // stored memories visible in context, not restrict it to "this conversation".
    expect(character.bio[0]).toMatch(/months later/);
    expect(character.system).toContain("in your context");
    expect(character.system).toContain("stored memories");
    expect(character.system).not.toContain("something a tool gave you this turn");
  });

  test("recall message example models context-scoped honesty instead of denying memory", () => {
    const recallExample = character.message_examples.find((example) =>
      example.some(
        (msg) =>
          typeof (msg.content as { text?: string })?.text === "string" &&
          ((msg.content as { text: string }).text.includes("do you remember") ||
            (msg.content as { text: string }).text.includes("remember what i told you")),
      ),
    );
    expect(recallExample).toBeDefined();

    const reply = (recallExample!.at(-1)!.content as { text: string }).text;
    // The reply must acknowledge stored memories exist (consistent with bio[0])
    // while honestly reporting what is actually visible — not a blanket denial.
    expect(reply).toMatch(/memories/);
    expect(reply).not.toContain("i don't have anything from last month");
  });

  test("never injects a web-search service that cannot start", async () => {
    // WebSearchService.initialize() throws unless runtime.getSetting() can see
    // a Google key, and the runtime only injects those keys for the
    // request-level webSearchEnabled toggle (buildSettings in
    // lib/eliza/runtime/settings.ts) — never from this character. Prove that
    // with the real service against exactly what this character's settings
    // make visible: the service cannot start from character settings alone.
    const settings = character.settings as Record<string, unknown>;
    const runtimeStub = {
      getSetting: (key: string) => (settings[key] as string | undefined) ?? null,
    } as unknown as IAgentRuntime;
    await expect(WebSearchService.start(runtimeStub)).rejects.toThrow(/GOOGLE_API_KEY/);

    // Therefore the character must not carry the settings key that makes the
    // agent loader inject @elizaos/plugin-web-search — same code path
    // AgentLoader.resolvePlugins uses — or every runtime creation logs a
    // "Service start failed" error for a dead plugin. Web search still works
    // for this character via the request-level toggle, which injects the
    // plugin and the keys together.
    expect(getConditionalPlugins(settings)).not.toContain("@elizaos/plugin-web-search");
  });

  test("topics are third-person — no second-person referent confusion", () => {
    for (const topic of character.topics) {
      expect(topic).not.toMatch(/\byou(?:'(?:re|ve))?\b|\byour\b/i);
    }
  });

  test("duplicate persona in lib/eliza/agent.ts carries the same context-scoped honesty rule", () => {
    // agent.ts holds a near-duplicate persona (see the header comment in
    // default-eliza-character.ts); until they are deduplicated, the honesty
    // scoping must stay in sync so both defaults behave the same way.
    expect(defaultAgent.character.system).toContain("in your context");
    expect(defaultAgent.character.system).toContain("stored memories");
    expect(defaultAgent.character.system).not.toContain("something a tool gave you this turn");
  });
});
