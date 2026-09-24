/**
 * Unit coverage for message-source classification (agent greeting, coding agent,
 * …). Pure functions, no live agent.
 */
import {
  MESSAGE_SOURCE_AGENT_GREETING,
  MESSAGE_SOURCE_CODING_AGENT,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isRoutineCodingAgentMessage } from "./index";

describe("chat message source sentinels", () => {
  it("detects routine coding-agent status messages via the shared source contract", () => {
    expect(
      isRoutineCodingAgentMessage({
        source: MESSAGE_SOURCE_CODING_AGENT,
        text: "[task-1] Turn done, continuing: next step",
      }),
    ).toBe(true);

    expect(
      isRoutineCodingAgentMessage({
        source: MESSAGE_SOURCE_AGENT_GREETING,
        text: "[task-1] Turn done, continuing: next step",
      }),
    ).toBe(false);
  });
});
