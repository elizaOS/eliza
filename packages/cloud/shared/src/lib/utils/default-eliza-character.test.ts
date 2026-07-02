import { describe, expect, test } from "vitest";
import defaultAgent from "../eliza/agent";
import { getConditionalPlugins } from "../eliza/agent-mode-types";
import { getDefaultElizaCharacterData } from "./default-eliza-character";

/**
 * The default Eliza character is what every new cloud signup gets. Its persona
 * promises (bio), behavioral rules (system), examples, and settings must stay
 * coherent with each other and with what the agent loader actually wires up —
 * a bio that promises months-later memory next to a rule that forbids recalling
 * anything outside the current conversation ships a self-contradicting agent,
 * and a tool-first system prompt with zero enabled tools ships a liar.
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

  test("web search is enabled and resolves to the plugin the loader injects", () => {
    expect(character.settings).toMatchObject({ webSearch: { enabled: true } });
    // Same code path AgentLoader.resolvePlugins uses for character settings.
    expect(getConditionalPlugins(character.settings)).toContain("@elizaos/plugin-web-search");
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
