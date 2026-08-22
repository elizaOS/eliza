/** Tests deterministic action-route fixtures used by real scenario harnesses. */

import { describe, expect, it } from "vitest";
import { ModelType } from "../../types/model.ts";
import {
  actionSlug,
  finalMessageUserText,
  matchesScenarioInput,
  registerStrictActionRouteFixtures,
  stage1ResponseHandlerFixture,
  strictActionRouteFixtures,
} from "../deterministic-action-fixtures.ts";

describe("finalMessageUserText", () => {
  it("strips the message:user: marker", () => {
    expect(finalMessageUserText("prefix message:user:\nHello there")).toBe(
      "Hello there",
    );
  });

  it("returns the input unchanged when no marker", () => {
    expect(finalMessageUserText("plain text")).toBe("plain text");
  });

  it("extracts text after the external-content separator", () => {
    const value =
      "message:user:\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nignored\n---\nREAL USER TEXT\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
    expect(finalMessageUserText(value)).toBe("REAL USER TEXT");
  });

  it("returns full envelope text when no separator", () => {
    const value =
      "message:user:\n<<<EXTERNAL_UNTRUSTED_CONTENT>>>\njust this\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
    expect(finalMessageUserText(value)).toBe("just this");
  });

  it("trims the trailing provider boundary", () => {
    const value = "message:user:\nBuy 10 apples\n\nevent: user_message";
    expect(finalMessageUserText(value)).toBe("Buy 10 apples");
  });
});

describe("matchesScenarioInput", () => {
  it("compares normalized text exactly", () => {
    const matcher = matchesScenarioInput("Buy apples");
    expect(matcher("message:user:\nBuy apples")).toBe(true);
    expect(matcher("message:user:\nBuy pears")).toBe(false);
  });
});

describe("actionSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(actionSlug("Send Email")).toBe("send-email");
    expect(actionSlug("GET_BALANCE")).toBe("get-balance");
    expect(actionSlug("simple")).toBe("simple");
  });
});

describe("stage1ResponseHandlerFixture", () => {
  it("routes to the candidate action", () => {
    const fixture = stage1ResponseHandlerFixture({
      actionName: "Check Balance",
      args: {},
      input: "what is my balance",
    });
    expect(fixture.match.modelType).toBe(ModelType.RESPONSE_HANDLER);
    expect(fixture.match.toolName).toBe("HANDLE_RESPONSE");
    expect(fixture.name).toContain("check-balance");
  });

  it("uses default context and reply when absent", () => {
    const fixture = stage1ResponseHandlerFixture({
      actionName: "X",
      args: {},
      input: "hi",
    });
    const response = fixture.response as { contexts: string[]; replyText: string };
    expect(response.contexts).toEqual(["general"]);
    expect(response.replyText).toBe("On it.");
  });
});

describe("strictActionRouteFixtures", () => {
  it("emits the stage1 + planner pair", () => {
    const fixtures = strictActionRouteFixtures({
      actionName: "SendEmail",
      args: { to: "a@b.c" },
      input: "email a",
    });
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0].match.modelType).toBe(ModelType.RESPONSE_HANDLER);
    expect(fixtures[1].match.modelType).toBe(ModelType.ACTION_PLANNER);
    const planner = fixtures[1].response as { toolCalls: { name: string }[] };
    expect(planner.toolCalls[0].name).toBe("SendEmail");
  });

  it("passes arguments through to the tool call", () => {
    const fixtures = strictActionRouteFixtures({
      actionName: "GetBalance",
      args: { address: "0x123" },
      input: "balance please",
    });
    const planner = fixtures[1].response as { toolCalls: { arguments: unknown }[] };
    expect(planner.toolCalls[0].arguments).toEqual({ address: "0x123" });
  });
});

describe("registerStrictActionRouteFixtures", () => {
  it("registers all fixtures onto the runtime bridge", () => {
    const register = (() => {
      const calls: unknown[][] = [];
      return {
        fn: (...f: unknown[]) => calls.push(f),
        calls,
      };
    })();
    const runtime = { scenarioModelFixtures: { register: register.fn } };
    registerStrictActionRouteFixtures(runtime, [
      { actionName: "A", args: {}, input: "a" },
      { actionName: "B", args: {}, input: "b" },
    ]);
    expect(register.calls).toHaveLength(1);
    expect(register.calls[0]).toHaveLength(4); // 2 specs × 2 fixtures
  });

  it("is a no-op when the runtime has no fixture bridge", () => {
    expect(() =>
      registerStrictActionRouteFixtures({}, [{ actionName: "A", args: {}, input: "a" }]),
    ).not.toThrow();
  });
});
