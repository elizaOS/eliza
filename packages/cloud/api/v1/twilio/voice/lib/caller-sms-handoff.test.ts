/** Tests explicit, verified-caller SMS handoffs without provider side effects. */

import { describe, expect, mock, test } from "bun:test";
import { createCallerSmsHandoff } from "./caller-sms-handoff";

function setup(overrides: { fromNumber?: string; callerNumber?: string } = {}) {
  const send = mock(
    async (
      _accountSid: string,
      _authToken: string,
      _body: URLSearchParams,
    ): Promise<void> => undefined,
  );
  const handle = createCallerSmsHandoff({
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: overrides.fromNumber ?? "+14484080429",
    callerNumber: overrides.callerNumber ?? "+12525914471",
    send,
  });
  return { handle, send };
}

describe("verified caller SMS handoff", () => {
  test("sends the continuation message only to the signed caller", async () => {
    const { handle, send } = setup();
    expect(await handle("Text me")).toEqual({
      handled: true,
      response: "Sent it to the number you're calling from.",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0]?.[2] as URLSearchParams;
    expect(Object.fromEntries(params)).toEqual({
      To: "+12525914471",
      From: "+14484080429",
      Body: "Eliza here — reply to this text to keep going after the call.",
    });
  });

  test("sends short dictated content and ignores unrelated speech", async () => {
    const { handle, send } = setup();
    expect(await handle("Please text me saying Buy oat milk")).toEqual({
      handled: true,
      response: "Sent it to the number you're calling from.",
    });
    expect(await handle("Find me a grocery store")).toEqual({ handled: false });
    const params = send.mock.calls[0]?.[2] as URLSearchParams;
    expect(params.get("Body")).toBe("Buy oat milk");
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("deduplicates successful requests within one call", async () => {
    const { handle, send } = setup();
    await handle("text me");
    expect(await handle("TEXT ME.")).toEqual({
      handled: true,
      response: "That text is already sent.",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("fails closed when either signed number is not E.164", async () => {
    const { handle, send } = setup({ callerNumber: "anonymous" });
    expect(await handle("text me")).toEqual({
      handled: true,
      response: "I can't safely text this call. We can keep going here.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("reports provider failure without claiming success", async () => {
    const send = mock(
      async (
        _accountSid: string,
        _authToken: string,
        _body: URLSearchParams,
      ): Promise<void> => {
        throw new Error("provider unavailable");
      },
    );
    const handle = createCallerSmsHandoff({
      accountSid: "AC123",
      authToken: "secret",
      fromNumber: "+14484080429",
      callerNumber: "+12525914471",
      send,
    });
    expect(await handle("text me")).toEqual({
      handled: true,
      response: "I couldn't send that text. We can keep going here.",
    });
  });
});
