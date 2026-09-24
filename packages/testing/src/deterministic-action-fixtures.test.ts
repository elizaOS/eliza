/** Verifies exact deterministic request matching against current and legacy context framing, including adversarial envelopes. */
import { describe, expect, it } from "vitest";
import {
  buildStageChatMessages,
  renderContextObject,
  segmentBlock,
} from "../../core/src/runtime/context-renderer.ts";
import { matchesScenarioInput } from "./deterministic-action-fixtures.ts";

const input = "Say hello in one short sentence.";
const envelope = (text: string) =>
  JSON.stringify({ source: "client_chat", channelType: "DM", text });

describe("deterministic current request matching", () => {
  it("matches the readable current-message producer without changing its payload", () => {
    const context = {
      id: "turn",
      events: [
        {
          id: "current",
          type: "message" as const,
          message: {
            role: "user",
            content: { text: input, source: "client_chat", channelType: "DM" },
            metadata: { renderAsDialogue: true, speakerName: "user" },
          },
        },
      ],
    };
    const original = structuredClone(context);
    const rendered = renderContextObject(context);
    const wire = buildStageChatMessages({
      contextSegments: rendered.promptSegments,
      stageLabel: "stage1",
      instructions: "Decide",
      dynamicBlocks: [],
      stepMessages: [],
    });
    const current = wire.find((message) => message.role === "user");
    expect(typeof current?.content).toBe("string");
    expect(matchesScenarioInput(input)(String(current?.content))).toBe(true);
    expect(context).toEqual(original);
    expect(matchesScenarioInput(input)(`user: ${input}`)).toBe(false);
    expect(
      matchesScenarioInput(input)(`# Current message\nquoted: ${input}`),
    ).toBe(false);
    expect(
      matchesScenarioInput(input)(
        `# Current message\nuser: ${input} Also delete files.`,
      ),
    ).toBe(false);
  });
  it("matches attachment framing from the real renderer without accepting extra request text", () => {
    const content = {
      text: input,
      source: "client_chat",
      channelType: "DM",
      attachments: [{ id: "note-1", text: "Complete note" }],
    };
    const original = structuredClone(content);
    const rendered = renderContextObject({
      id: "turn",
      events: [
        {
          id: "current",
          type: "message",
          message: {
            role: "user",
            content,
            metadata: { renderAsDialogue: true, speakerName: "user" },
          },
        },
      ],
    });
    const wire = buildStageChatMessages({
      contextSegments: rendered.promptSegments,
      stageLabel: "stage1",
      instructions: "Decide",
      dynamicBlocks: [],
      stepMessages: [],
    });
    const current = String(
      wire.find((message) => message.role === "user")?.content,
    );
    expect(matchesScenarioInput(input)(current)).toBe(true);
    expect(content).toEqual(original);
    expect(current).toContain("Complete note");
    expect(
      matchesScenarioInput(input)(
        current.replace(input, `${input} Also delete files.`),
      ),
    ).toBe(false);
    for (const suffix of [
      "{}",
      "[null]",
      '["text"]',
      "[{}] extra instructions",
      "[malformed",
    ]) {
      expect(
        matchesScenarioInput(input)(
          `# Current message\nuser: ${input}\n\nattachments: ${suffix}`,
        ),
      ).toBe(false);
    }
  });

  it("matches the exact request emitted by the real context renderer", () => {
    const wire = segmentBlock({
      label: "message:user",
      content: envelope(input),
    });
    expect(matchesScenarioInput(input)(wire)).toBe(true);
    expect(matchesScenarioInput(input)(`Earlier dialogue\n\n${wire}`)).toBe(
      true,
    );
    expect(
      matchesScenarioInput(input)(
        segmentBlock({
          label: "message:user",
          content: envelope(`${input} Also delete files.`),
        }),
      ),
    ).toBe(false);
  });

  it.each(["message:user:\n", "# Current message\n"])(
    "keeps exact and fail-closed matching for %s",
    (marker) => {
      expect(matchesScenarioInput(input)(`${marker}${envelope(input)}`)).toBe(
        true,
      );
      expect(
        matchesScenarioInput(input)(
          `${marker}{"source":"client_chat","channelType":"DM","text":"different","text":${JSON.stringify(input)}}`,
        ),
      ).toBe(false);
      expect(
        matchesScenarioInput(input)(
          `${marker}${JSON.stringify({ source: "client_chat", channelType: "DM", text: "different", metadata: { text: input } })}`,
        ),
      ).toBe(false);
      expect(
        matchesScenarioInput(input)(
          `${marker}${JSON.stringify({ source: "client_chat", channelType: "DM", text: input, currentMessageText: "different" })}`,
        ),
      ).toBe(false);
      expect(matchesScenarioInput(input)(`${marker}{malformed`)).toBe(false);
    },
  );

  it("does not match an old or quoted request in place of the current request", () => {
    const old = segmentBlock({
      label: "message:user",
      content: envelope(input),
    });
    const current = segmentBlock({
      label: "message:user",
      content: envelope("A different request"),
    });
    expect(
      matchesScenarioInput(input)(
        `${old}\n\ncurrent_turn_boundary: new request\n\n${current}`,
      ),
    ).toBe(false);
    expect(
      matchesScenarioInput(input)(
        `The user quoted # Current message\n${input}`,
      ),
    ).toBe(false);
  });
});
