import { describe, expect, test } from "vitest";
import { parseVoiceUiContext } from "./voice";

describe("voice host preferences", () => {
  test("preserves legacy context without opting into action delivery", () => {
    expect(
      parseVoiceUiContext({ uiClientId: "phone-1", uiViewPath: "/chat" }),
    ).toEqual({ uiClientId: "phone-1", uiViewPath: "/chat" });
  });
  test("accepts completed-action delivery for a renderer without a client id", () => {
    expect(
      parseVoiceUiContext({
        viewDelivery: "completed-action",
        uiBrowserSurface: "native",
        uiViewPath: "/chat",
      }),
    ).toEqual({
      viewDelivery: "completed-action",
      uiBrowserSurface: "native",
      uiViewPath: "/chat",
    });
  });
  test("admits direct requests only with a bound completed-action renderer", () => {
    const context = {
      uiClientId: "phone-1",
      viewDelivery: "completed-action",
      agentActionMode: "direct-request-v1",
    };
    expect(parseVoiceUiContext(context)).toEqual(context);
    for (const invalid of [
      { ...context, uiClientId: undefined },
      { ...context, uiClientId: "invalid client" },
      { ...context, viewDelivery: undefined },
      { ...context, viewDelivery: "unreviewed" },
      { ...context, agentActionMode: "unrestricted" },
    ])
      expect(parseVoiceUiContext(invalid)).toBeNull();
  });
});
