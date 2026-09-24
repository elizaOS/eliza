/** Verifies exact deterministic request matching against current and legacy context framing, including adversarial envelopes. */
import { describe, expect, it } from "vitest";
import { segmentBlock } from "../../core/src/runtime/context-renderer.ts";
import { matchesScenarioInput } from "./deterministic-action-fixtures.ts";

const input = "Say hello in one short sentence.";
const envelope = (text: string) =>
  JSON.stringify({ source: "client_chat", channelType: "DM", text });

describe("deterministic current request matching", () => {
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
