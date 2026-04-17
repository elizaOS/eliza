import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  callExternalAction,
  callUserAction,
  __internal,
} from "../src/actions/twilio-call.js";

const ORIGINAL_ENV = { ...process.env };

function makeMessage() {
  return {
    entityId: "00000000-0000-0000-0000-000000000001",
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "call", ownerAccess: true },
  } as unknown as Parameters<
    NonNullable<typeof callUserAction.handler>
  >[1];
}

function makeRuntime(settings: Record<string, string> = {}) {
  return {
    agentId: "00000000-0000-0000-0000-000000000003",
    getSetting: (key: string) => settings[key],
    character: { settings: { OWNER: "test" } },
  } as unknown as Parameters<
    NonNullable<typeof callUserAction.handler>
  >[0];
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("TWILIO_") ||
      key.startsWith("MILADY_E2E_TWILIO") ||
      key === "MILADY_DEVICE_BUS_URL"
    ) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("readExternalAllowList", () => {
  test("parses comma/space separated env, includes owner number", () => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST = "+15551112222, +15553334444";
    process.env.MILADY_E2E_TWILIO_RECIPIENT = "+15559876543";
    const list = __internal.readExternalAllowList(undefined);
    expect(list).toContain("+15551112222");
    expect(list).toContain("+15553334444");
    expect(list).toContain("+15559876543");
  });

  test("empty when nothing configured", () => {
    const list = __internal.readExternalAllowList(undefined);
    expect(list).toEqual([]);
  });
});

describe("CALL_USER confirmation gate", () => {
  test("without confirmed=true returns requiresConfirmation and does not dial", async () => {
    process.env.MILADY_E2E_TWILIO_RECIPIENT = "+15559876543";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callUserAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: {} },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    const data = r.data ?? {};
    expect(
      data.requiresConfirmation === true || data.error === "PERMISSION_DENIED",
    ).toBe(true);
  });
});

describe("CALL_EXTERNAL allow-list gate", () => {
  test("unknown recipient rejected even with confirmed=true", async () => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST = "+15551112222";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_PHONE_NUMBER = "+15550000000";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callExternalAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { confirmed: true, to: "+15557654321" } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    const data = r.data ?? {};
    expect(
      data.reason === "disallowed-recipient" ||
        data.error === "PERMISSION_DENIED",
    ).toBe(true);
  });

  test("missing confirmed flag returns requiresConfirmation and does not call", async () => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST = "+15551112222";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await callExternalAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { to: "+15551112222" } },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    const r = result as { success: boolean };
    expect(r.success).toBe(false);
  });
});
