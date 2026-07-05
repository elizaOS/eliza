/**
 * Error-policy pins for the WhatsApp automation connector (#13415). The file
 * already fails closed everywhere — no catch fabricates success or delivery —
 * so these tests lock that in: an internal transport/API failure must surface
 * with its real error and stay DISTINGUISHABLE from a designed "invalid" /
 * "not configured" verdict, and it must never read as a valid token or a
 * delivered message. Drives the real exported `whatsappAutomationService`
 * (validateAccessToken + sendMessage → the real whatsapp-api util) with only
 * `global.fetch`, the cache client, and the secrets service mocked.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV = "test";

const ORG_ID = "00000000-0000-4000-8000-00000000d001";

// sendMessage reads org credentials through the secrets service; null models a
// legitimately-unconfigured org (the designed-empty case, not a failure).
let storedAccessToken: string | null = "org-access-token";
let storedPhoneNumberId: string | null = "1234567890";

mock.module("../secrets", () => ({
  secretsService: {
    get: async (_org: string, name: string) => {
      if (name.includes("ACCESS_TOKEN")) return storedAccessToken;
      if (name.includes("PHONE_NUMBER_ID")) return storedPhoneNumberId;
      return null;
    },
  },
}));

// The status path touches the cache client on import; keep it inert and offline.
mock.module("../../cache/client", () => ({
  cache: {
    get: async () => null,
    set: async () => {},
    del: async () => {},
  },
}));

const { whatsappAutomationService } = await import("./index");

const realFetch = globalThis.fetch;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchImpl;

beforeEach(() => {
  storedAccessToken = "org-access-token";
  storedPhoneNumberId = "1234567890";
  // Default: any unexpected network call is a hard failure, not a silent pass.
  fetchImpl = async () => {
    throw new Error("unexpected network call in test");
  };
  globalThis.fetch = ((url: string, init?: RequestInit) => fetchImpl(url, init)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("validateAccessToken error policy (#13415)", () => {
  test("internal transport failure surfaces a distinct network error, never valid:true", async () => {
    fetchImpl = async () => {
      throw new Error("ETIMEDOUT connecting to graph.facebook.com");
    };

    const result = await whatsappAutomationService.validateAccessToken("some-token", "1234567890");

    expect(result.valid).toBe(false);
    expect(result.phoneDisplay).toBeUndefined();
    // The network-failure verdict is worded distinctly from a designed 401.
    expect(result.error).toBe("Validation failed due to network error. Please try again.");
  });

  test("designed 401 'Invalid access token' stays distinct from a transport failure", async () => {
    fetchImpl = async () => new Response("bad token", { status: 401 });

    const result = await whatsappAutomationService.validateAccessToken("bad-token", "1234567890");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    // Distinguishable: the invalid-credential message is not the network message.
    expect(result.error).not.toBe("Validation failed due to network error. Please try again.");
  });

  test("a working token is distinguishable: valid:true with phoneDisplay", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          display_phone_number: "+1 415-555-0100",
          verified_name: "Test Biz",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await whatsappAutomationService.validateAccessToken("good-token", "1234567890");

    expect(result.valid).toBe(true);
    expect(result.phoneDisplay).toBe("+1 415-555-0100");
    expect(result.error).toBeUndefined();
  });
});

describe("sendMessage error policy (#13415)", () => {
  test("outbound API failure surfaces success:false with the real error, never fabricated delivery", async () => {
    let sendAttempted = false;
    fetchImpl = async () => {
      sendAttempted = true;
      // A 500 from Meta makes the real whatsapp-api util throw.
      return new Response("internal error", { status: 500 });
    };

    const result = await whatsappAutomationService.sendMessage(ORG_ID, "14155550100", "hi");

    expect(sendAttempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.messageId).toBeUndefined();
    // The real transport error text propagates (not a generic swallowed default).
    expect(result.error).toContain("500");
    // And it is NOT the designed not-configured message.
    expect(result.error).not.toBe("WhatsApp not configured");
  });

  test("designed 'not configured' state stays distinct and attempts no send", async () => {
    storedAccessToken = null;
    storedPhoneNumberId = null;
    let sendAttempted = false;
    fetchImpl = async () => {
      sendAttempted = true;
      return new Response("{}", { status: 200 });
    };

    const result = await whatsappAutomationService.sendMessage(ORG_ID, "14155550100", "hi");

    expect(result.success).toBe(false);
    expect(result.error).toBe("WhatsApp not configured");
    expect(result.messageId).toBeUndefined();
    // A legitimately-unconfigured connector: no outbound call was made.
    expect(sendAttempted).toBe(false);
  });

  test("successful send is distinguishable: success:true with the returned message id", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "14155550100", wa_id: "14155550100" }],
          messages: [{ id: "wamid.TEST123" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await whatsappAutomationService.sendMessage(ORG_ID, "14155550100", "hi");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("wamid.TEST123");
    expect(result.error).toBeUndefined();
  });
});
