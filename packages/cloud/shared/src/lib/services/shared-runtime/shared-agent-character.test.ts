/**
 * Pins full behavioral persona projection into the Shared AgentRuntime while
 * excluding character-controlled plugins, secrets, settings, and knowledge.
 */

import { describe, expect, test } from "bun:test";
import type { UserCharacter } from "../../../db/repositories/characters";
import { projectSharedAgentCharacter } from "./shared-agent-character";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

function agent(agentConfig: Record<string, unknown>): SharedRuntimeAgent {
  return {
    id: "agent-1",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Eliza",
    agent_config: agentConfig,
    execution_tier: "shared",
  };
}

describe("projectSharedAgentCharacter", () => {
  test("projects behavioral fields but not capability authority", () => {
    const projected = projectSharedAgentCharacter(
      agent({
        character: {
          name: "Nyx",
          system: "You are {{name}}.",
          bio: ["Useful."],
          adjectives: ["dry", "capable"],
          topics: ["planning"],
          style: { all: ["answer first"], chat: ["be direct"], post: ["one idea"] },
          postExamples: ["A useful post."],
          messageExamples: [
            {
              examples: [
                { name: "{{user1}}", content: { text: "help" } },
                { name: "{{agentName}}", content: { text: "What is stuck?" } },
              ],
            },
          ],
          character_data: { templates: { transientFailureReply: "Try that again." } },
          plugins: ["untrusted-plugin"],
          settings: { ENABLE_AUTONOMY: true },
          secrets: { TOKEN: "must-not-project" },
          knowledge: ["must-not-project"],
        },
      }),
    );

    expect(projected).toEqual({
      name: "Nyx",
      system: "You are {{name}}.",
      bio: ["Useful."],
      messageExamples: [
        {
          examples: [
            { name: "{{user1}}", content: { text: "help" } },
            { name: "{{agentName}}", content: { text: "What is stuck?" } },
          ],
        },
      ],
      postExamples: ["A useful post."],
      topics: ["planning"],
      adjectives: ["dry", "capable"],
      style: { all: ["answer first"], chat: ["be direct"], post: ["one idea"] },
      templates: { transientFailureReply: "Try that again." },
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-project");
    expect(JSON.stringify(projected)).not.toContain("untrusted-plugin");
  });

  test("linked character wins without merging fallback persona arrays", () => {
    const linked = {
      organization_id: "org-1",
      name: "Linked",
      system: "Linked system",
      bio: ["Linked bio"],
      message_examples: [
        [
          { name: "person", content: { text: "hello" } },
          { name: "Linked", content: { text: "hi" } },
        ],
      ],
      topics: ["linked topic"],
      adjectives: ["linked adjective"],
      style: { chat: ["linked style"] },
      character_data: { templates: { rateLimitedReply: "Wait a moment." } },
      settings: { model: "linked-model" },
    } as unknown as UserCharacter;

    const projected = projectSharedAgentCharacter(
      agent({ system: "fallback", bio: ["fallback bio"], topics: ["fallback topic"] }),
      linked,
    );
    expect(projected.bio).toEqual(["Linked bio"]);
    expect(projected.topics).toEqual(["linked topic"]);
    expect(projected.messageExamples?.[0]?.examples[1]?.content.text).toBe("hi");
    expect(projected.templates).toEqual({ rateLimitedReply: "Wait a moment." });
    expect(projected.model).toBe("linked-model");
  });

  test("rejects linked characters from another organization", () => {
    expect(() =>
      projectSharedAgentCharacter(agent({}), {
        organization_id: "other-org",
      } as unknown as UserCharacter),
    ).toThrow("linked character organization mismatch");
  });
});
