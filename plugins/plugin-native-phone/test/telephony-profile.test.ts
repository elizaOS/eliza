import { beforeEach, describe, expect, mock, test } from "bun:test";
// The workspace source of the contract, so this test does not depend on an
// installed or built copy of @elizaos/contracts.
import * as telephony from "../../../packages/contracts/src/native-telephony.ts";

mock.module("@elizaos/contracts/native-telephony", () => telephony);
const { createTelephonyClient } = telephony;
const placeCall = mock(async () => {});
mock.module("@elizaos/plugin-native-phone/bridge", () => ({
  Phone: { placeCall },
}));

const { callFromPhone, registerTelephonyProfile, telephonyProfile } =
  await import("../src/telephony-profile");

function plugin(dialAnswer: unknown) {
  const dial = mock(async (_: { number: string }) => dialAnswer);
  return { dial, client: createTelephonyClient({ dial } as never, true) };
}

describe("Phone call path", () => {
  beforeEach(() => {
    placeCall.mockClear();
    registerTelephonyProfile(null);
  });

  test("places a direct call when no profile is registered", async () => {
    expect(await callFromPhone("+15551234567")).toEqual({ path: "direct" });
    expect(placeCall).toHaveBeenCalledWith({ number: "+15551234567" });
  });

  test("ignores an unadmitted client", () => {
    registerTelephonyProfile(createTelephonyClient({} as never, false));
    expect(telephonyProfile()).toBeNull();
  });

  test("behind the profile only opens the dial screen", async () => {
    const { dial, client } = plugin({
      status: "handed-off",
      target: "dialer",
      handler: "example.host",
      message: "Review the number and press Call.",
    });
    const clear = registerTelephonyProfile(client);
    const outcome = await callFromPhone("+15551234567");
    clear();
    expect(outcome).toEqual({
      path: "handoff",
      result: {
        status: "handed-off",
        target: "dialer",
        handler: "example.host",
        message: "Review the number and press Call.",
      },
    });
    expect(dial).toHaveBeenCalledWith({ number: "+15551234567" });
    expect(placeCall).not.toHaveBeenCalled();
  });

  test("refuses a malformed handoff answer instead of claiming a call", async () => {
    const { client } = plugin({ status: "called", target: "dialer" });
    const clear = registerTelephonyProfile(client);
    await expect(callFromPhone("+15551234567")).rejects.toThrow();
    clear();
    expect(placeCall).not.toHaveBeenCalled();
  });
});
