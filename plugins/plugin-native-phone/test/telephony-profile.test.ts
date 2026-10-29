import { beforeEach, describe, expect, mock, test } from "bun:test";
// The workspace source of the contract, so this test does not depend on an
// installed or built copy of @elizaos/contracts.
import * as telephony from "../../../packages/contracts/src/native-telephony.ts";

mock.module("@elizaos/contracts/native-telephony", () => telephony);
const { createTelephonyClient } = telephony;
const placeCall = mock(async () => {});
const openDialer = mock(async (_?: { number: string }) => {});
mock.module("@elizaos/plugin-native-phone/bridge", () => ({
  Phone: { placeCall, openDialer },
}));

const {
  callFromPhone,
  loadProfileRecents,
  openDialerFromPhone,
  registerTelephonyProfile,
  telephonyProfile,
} = await import("../src/telephony-profile");

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

const statusWith = (callLog?: string) => ({
  version: 2,
  voiceCapable: true,
  smsCapable: true,
  permissions: {
    contacts: "granted",
    phoneState: "denied",
    sms: "denied",
    sendSms: "denied",
    ...(callLog ? { callLog } : {}),
  },
  sendMode: "handoff",
  roles: {
    dialer: { available: true, held: false, eligible: true },
    sms: { available: true, held: false, eligible: true },
  },
  defaultDialer: "com.android.dialer",
  defaultSms: null,
  subscriptions: null,
  defaultSmsSubscriptionId: null,
});

describe("Phone recents behind the profile", () => {
  beforeEach(() => {
    openDialer.mockClear();
    registerTelephonyProfile(null);
  });

  test("a host without the read is absent, never an empty history", async () => {
    const listRecentCalls = mock(async () => ({ calls: [] }));
    const client = createTelephonyClient(
      { status: async () => statusWith(), listRecentCalls } as never,
      true,
    );
    expect(await loadProfileRecents(client)).toEqual({
      access: "absent",
      voiceCapable: true,
    });
    expect(listRecentCalls).not.toHaveBeenCalled();
  });

  test("access is requested only when the person asks", async () => {
    const requestAccess = mock(async () => statusWith("granted"));
    const listRecentCalls = mock(async (_: { limit: number }) => ({
      calls: [
        {
          id: "7",
          number: "+15551234567",
          cachedName: "Ada",
          date: 1700000000000,
          durationSeconds: 61,
          type: "incoming",
          isNew: false,
        },
      ],
    }));
    const client = createTelephonyClient(
      {
        status: async () => statusWith("prompt"),
        requestAccess,
        listRecentCalls,
      } as never,
      true,
    );
    expect(await loadProfileRecents(client)).toEqual({
      access: "needed",
      voiceCapable: true,
    });
    expect(requestAccess).not.toHaveBeenCalled();
    const granted = await loadProfileRecents(client, { request: true });
    expect(requestAccess).toHaveBeenCalledWith({ access: "callLog" });
    expect(listRecentCalls).toHaveBeenCalledWith({ limit: 50 });
    expect(granted.access).toBe("granted");
    if (granted.access !== "granted") throw new Error("unreachable");
    expect(granted.calls[0]).toMatchObject({
      id: "7",
      number: "+15551234567",
      type: "incoming",
      transcription: null,
      agentTranscript: null,
    });
  });

  test("opening the dialer is a handoff behind the profile", async () => {
    const { dial, client } = plugin({
      status: "handed-off",
      target: "dialer",
      handler: null,
      message: "open",
    });
    const clear = registerTelephonyProfile(client);
    const outcome = await openDialerFromPhone("+15551234567");
    await expect(openDialerFromPhone("")).rejects.toThrow();
    clear();
    expect(outcome.path).toBe("handoff");
    expect(dial).toHaveBeenCalledWith({ number: "+15551234567" });
    expect(openDialer).not.toHaveBeenCalled();
    expect(await openDialerFromPhone("")).toEqual({ path: "direct" });
    expect(openDialer).toHaveBeenCalledWith(undefined);
  });
});
