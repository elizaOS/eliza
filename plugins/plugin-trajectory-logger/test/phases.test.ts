/**
 * `extractShouldRespondDecision()` must read the respond/ignore verdict the
 * HANDLE step actually reached, whether the model states it before or after
 * its reasoning, as a key/value or XML field, or as JSON.
 */
import { describe, expect, it } from "vitest";
import type { UILlmCall } from "../src/api-client";
import { extractShouldRespondDecision } from "../src/phases";

function call(response: string): UILlmCall {
  return {
    id: "call-1",
    model: "test-model",
    response,
    purpose: "should_respond",
    actionType: "",
    stepType: "should_respond",
  };
}

describe("extractShouldRespondDecision", () => {
  it("reads a verdict stated before its explanation", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "IGNORE - the user is talking to someone else, no need to respond.",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("RESPOND. They asked me directly; I should not ignore them."),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("reads a verdict stated after its reasoning", () => {
    expect(
      extractShouldRespondDecision(call("Should I respond? No, IGNORE.")),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("Respond to this? The user asked me by name, so RESPOND."),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("prefers an explicit key/value verdict field over reasoning keywords", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "reasoning: I could respond, but this is not addressed to me.\naction: IGNORE\nnote: would reply if mentioned",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
    expect(
      extractShouldRespondDecision(
        call("IGNORE would be rude here.\ndecision = RESPOND"),
      ),
    ).toEqual({ decision: "RESPOND" });
  });

  it("prefers an explicit XML verdict field over reasoning keywords", () => {
    expect(
      extractShouldRespondDecision(
        call(
          "<response><reasoning>Nobody asked me to respond; skip.</reasoning><action>IGNORE</action></response> I might reply later.",
        ),
      ),
    ).toEqual({ decision: "IGNORE" });
  });

  it("reads the JSON action and reasoning", () => {
    expect(
      extractShouldRespondDecision(
        call(
          '```json\n{"reasoning": "They said ignore me", "action": "respond"}\n```',
        ),
      ),
    ).toEqual({ decision: "RESPOND", reasoning: "They said ignore me" });
    expect(extractShouldRespondDecision(call('{"decision": "stop"}'))).toEqual({
      decision: "STOP",
    });
  });

  it("returns null when no verdict is present", () => {
    expect(extractShouldRespondDecision(call("   "))).toBeNull();
    expect(
      extractShouldRespondDecision(call("I am not sure what to do here.")),
    ).toBeNull();
  });
});
