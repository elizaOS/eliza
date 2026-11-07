import { createTelephonyClient } from "@elizaos/contracts/native-telephony";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendSms = vi.fn();
vi.mock("@elizaos/plugin-native-messages/bridge", () => ({
  Messages: { sendSms },
}));

const {
  registerTelephonyProfile,
  sendFromMessages,
  SmsDraftRefused,
  telephonyProfile,
} = await import("./telephony-profile");

const status = {
  version: 2,
  voiceCapable: true,
  smsCapable: true,
  permissions: {
    contacts: "granted",
    phoneState: "granted",
    sms: "granted",
    sendSms: "granted",
  },
  sendMode: "direct",
  roles: {
    dialer: { available: true, held: false, eligible: false },
    sms: { available: true, held: true, eligible: true },
  },
  defaultDialer: "com.android.dialer",
  defaultSms: "example.host",
  subscriptions: [
    {
      id: 3,
      slot: 0,
      displayName: "Work",
      carrierName: "Carrier A",
      defaultSms: true,
      defaultVoice: true,
    },
  ],
  defaultSmsSubscriptionId: 3,
};

function nativePlugin(overrides: Record<string, unknown> = {}) {
  return {
    imageCapability: vi.fn(),
    status: vi.fn(async () => status),
    requestAccess: vi.fn(),
    requestRole: vi.fn(),
    searchContacts: vi.fn(),
    dial: vi.fn(),
    composeSms: vi.fn(),
    listThreads: vi.fn(),
    listMessages: vi.fn(),
    observeMessages: vi.fn(),
    markThreadRead: vi.fn(),
    sendSms: vi.fn(),
    cancelSmsReview: vi.fn(),
    smsSendHistory: vi.fn(),
    smsSendResult: vi.fn(),
    ...overrides,
  };
}

describe("Messages send path", () => {
  let clear: (() => void) | undefined;
  beforeEach(() => sendSms.mockReset());
  afterEach(() => clear?.());

  it("uses the direct bridge when no profile is registered", async () => {
    sendSms.mockResolvedValue({
      messageId: "1",
      messageUri: "content://sms/1",
    });
    const outcome = await sendFromMessages("+15551234567", "hi");
    expect(outcome.path).toBe("direct");
    expect(sendSms).toHaveBeenCalledWith({
      address: "+15551234567",
      body: "hi",
    });
  });

  it("never keeps an unadmitted client", () => {
    clear = registerTelephonyProfile(
      createTelephonyClient(nativePlugin() as never, false),
    );
    expect(telephonyProfile()).toBeNull();
  });

  it("refuses a draft through the shared review before native code", async () => {
    const plugin = nativePlugin();
    clear = registerTelephonyProfile(
      createTelephonyClient(plugin as never, true),
    );
    await expect(sendFromMessages("not a number", "hi")).rejects.toBeInstanceOf(
      SmsDraftRefused,
    );
    expect(plugin.sendSms).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("sends behind the profile only through the reviewed native send", async () => {
    let seen: Record<string, unknown> | undefined;
    const plugin = nativePlugin();
    clear = registerTelephonyProfile(
      createTelephonyClient(plugin as never, true),
    );
    plugin.sendSms.mockImplementation(
      async (options: Record<string, unknown>) => {
        seen = options;
        throw new Error("native review cancelled");
      },
    );
    await expect(sendFromMessages("+15551234567", "hi")).rejects.toThrow(
      "native review cancelled",
    );
    expect(sendSms).not.toHaveBeenCalled();
    expect(seen).toMatchObject({
      recipients: ["+15551234567"],
      body: "hi",
      subscriptionId: 3,
    });
    expect(String(seen?.operationId)).toMatch(/^messages-[0-9a-f-]{36}$/);
  });

  it("clears only its own registration", () => {
    const first = registerTelephonyProfile(
      createTelephonyClient(nativePlugin() as never, true),
    );
    clear = registerTelephonyProfile(
      createTelephonyClient(nativePlugin() as never, true),
    );
    first();
    expect(telephonyProfile()).not.toBeNull();
  });
});
