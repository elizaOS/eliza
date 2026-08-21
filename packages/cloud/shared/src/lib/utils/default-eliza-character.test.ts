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

  test("web-search service starts keyless from this character's settings", async () => {
    // WebSearchService no longer requires a Google key to start: without one
    // it serves the keyless MCP path (Parallel → Exa). Prove the service
    // starts from exactly what this character's settings make visible, so an
    // injected plugin can never be a dead "Service start failed" logger.
    const settings = character.settings as Record<string, unknown>;
    const runtimeStub = {
      getSetting: (key: string) => (settings[key] as string | undefined) ?? null,
    } as unknown as IAgentRuntime;
    const service = await WebSearchService.start(runtimeStub);
    expect(service.capabilityDescription).toContain("keyless");

    // Plugin injection stays request-scoped: the character itself still must
    // not carry the settings key that makes AgentLoader.resolvePlugins inject
    // @elizaos/plugin-web-search — the request-level webSearchEnabled toggle
    // owns that decision.
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

  test("hosted and signup adapters preserve every common persona field", () => {
    expect(defaultAgent.character.system).toBe(character.system);
    expect(defaultAgent.character.bio).toEqual(character.bio);
    expect(defaultAgent.character.topics).toEqual(character.topics);
    expect(defaultAgent.character.adjectives).toEqual(character.adjectives);
    expect(defaultAgent.character.style).toEqual(character.style);
    expect(defaultAgent.character.postExamples).toEqual(character.post_examples);

    expect(defaultAgent.character.messageExamples).toEqual(character.message_examples);
    expect(defaultAgent.character.messageExamples[0]?.[0]?.name).toBe("{{name1}}");
    expect(defaultAgent.character.messageExamples[0]?.[1]?.name).toBe(character.name);
    expect(defaultAgent.character.messageExamples[0]?.[0]).not.toHaveProperty("user");
  });
});

/**
 * Voice invariants. This character is the first thing a new signup talks to, so
 * its register is a product surface: punctuation and length are not cosmetic
 * preferences here, they are the difference between reading as a person and
 * reading as generated text.
 */
describe("default Eliza voice", () => {
  const character = getDefaultElizaCharacterData();
  const spoken = [
    character.system,
    ...character.bio,
    ...character.topics,
    ...character.style.all,
    ...character.style.chat,
    ...character.message_examples.flatMap((example) =>
      example.map((msg) => (msg.content as { text?: string })?.text ?? ""),
    ),
  ];

  test("no em-dashes anywhere the agent can be heard", () => {
    for (const line of spoken) {
      expect(line).not.toMatch(/[—–]/);
    }
  });

  test("no emoji", () => {
    for (const line of spoken) {
      expect(line).not.toMatch(
        /(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]|\u{FE0F})/u,
      );
    }
  });

  test("no stock AI phrasing in anything the agent says", () => {
    const slop = [
      "delve",
      "seamless",
      "robust",
      "dive in",
      "i'd be happy to",
      "i hope this helps",
      "great question",
      "it's not just",
    ];
    // Only utterances are checked. `system` and `style` legitimately quote these
    // phrases in order to forbid them, so linting them here would be backwards.
    const utterances = [
      ...character.bio,
      ...character.message_examples.flatMap((example) =>
        example.map((msg) => (msg.content as { text?: string })?.text ?? ""),
      ),
    ];
    for (const line of utterances) {
      const lower = line.toLowerCase();
      for (const phrase of slop) {
        expect(lower).not.toContain(phrase);
      }
    }
  });

  test("keeps consumer identity free of company and framework biography", () => {
    const identity = [
      character.system,
      ...character.bio,
      ...character.topics,
      ...character.message_examples.flatMap((example) =>
        example.map((message) => (message.content as { text?: string }).text ?? ""),
      ),
    ].join("\n");
    expect(character.system).toContain('say "I\'m {{name}}."');
    expect(identity).not.toMatch(
      /eliza research|san francisco|elizaos|open source|self-host|github\.com|api_key|model provider/i,
    );
  });

  test("replies stay short: median reply is a sentence, not a paragraph", () => {
    const replies = character.message_examples
      .map((example) => (example.at(-1)!.content as { text: string }).text)
      .map((text) => text.split(/\s+/).length)
      .sort((a, b) => a - b);
    const median = replies[Math.floor(replies.length / 2)];
    expect(median).toBeLessThanOrEqual(20);
    // No single canned reply should read as a wall of text either.
    expect(Math.max(...replies)).toBeLessThanOrEqual(40);
  });
});
