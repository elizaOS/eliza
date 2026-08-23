/**
 * Unit coverage for the contacts permission prober. Drives the real
 * `contactsProber` so Darwin native-status mapping, TCC AddressBook
 * fallback, request() lastRequested stamping, and the non-Darwin
 * short-circuit are asserted against live `buildState` output. Only the
 * dylib, TCC, bundle-id, and privacy-pane collaborators are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNativeDylib,
  openPrivacyPane,
  queryTccStatus,
  resolveBundleId,
} from "./_bridge.ts";
import { contactsProber } from "./contacts.ts";

const darwin = vi.hoisted(() => ({ value: true }));

vi.mock("./_bridge.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.ts")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.value;
    },
    getNativeDylib: vi.fn(),
    queryTccStatus: vi.fn(),
    resolveBundleId: vi.fn(),
    openPrivacyPane: vi.fn(),
  };
});

const mockGetNativeDylib = vi.mocked(getNativeDylib);
const mockQueryTcc = vi.mocked(queryTccStatus);
const mockResolveBundleId = vi.mocked(resolveBundleId);
const mockOpenPrivacyPane = vi.mocked(openPrivacyPane);

const BUNDLE_ID = "ai.elizaos.contacts-test";

function stubNativeLib(options: { check: number; request?: number }) {
  return {
    checkContactsPermission: () => options.check,
    requestContactsPermission: () => options.request ?? options.check,
  };
}

describe("contactsProber", () => {
  beforeEach(() => {
    darwin.value = true;
    mockGetNativeDylib.mockReset();
    mockQueryTcc.mockReset();
    mockResolveBundleId.mockReset();
    mockOpenPrivacyPane.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
    mockQueryTcc.mockResolvedValue(null);
    mockResolveBundleId.mockReturnValue(BUNDLE_ID);
    mockOpenPrivacyPane.mockResolvedValue(undefined);
  });

  afterEach(() => {
    darwin.value = true;
  });

  it("exposes the contacts permission id", () => {
    expect(contactsProber.id).toBe("contacts");
  });

  it("check() returns platform-unsupported on non-Darwin without probing", async () => {
    darwin.value = false;
    const state = await contactsProber.check();
    expect(state).toMatchObject({
      id: "contacts",
      status: "not-applicable",
      canRequest: false,
      restrictedReason: "platform_unsupported",
    });
    expect(typeof state.lastChecked).toBe("number");
    expect(state.lastRequested).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
    expect(mockQueryTcc).not.toHaveBeenCalled();
  });

  it("check() maps native granted (2) and skips TCC", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 2 }) as never);
    const state = await contactsProber.check();
    expect(state.id).toBe("contacts");
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(mockQueryTcc).not.toHaveBeenCalled();
    expect(mockResolveBundleId).not.toHaveBeenCalled();
  });

  it("check() maps native denied (1)", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 1 }) as never);
    const state = await contactsProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("check() maps native restricted (3) to os_policy and cannot re-request", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 3 }) as never);
    const state = await contactsProber.check();
    expect(state.status).toBe("restricted");
    expect(state.restrictedReason).toBe("os_policy");
    expect(state.canRequest).toBe(false);
  });

  it("check() maps native write-only (4) to restricted without canRequest", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 4 }) as never);
    const state = await contactsProber.check();
    expect(state.status).toBe("restricted");
    expect(state.restrictedReason).toBe("os_policy");
    // Contacts, unlike calendar/reminders, does not treat write-only as requestable.
    expect(state.canRequest).toBe(false);
  });

  it("check() maps native not-determined (0) as requestable", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 0 }) as never);
    const state = await contactsProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("check() maps an unknown native code to not-determined", async () => {
    mockGetNativeDylib.mockResolvedValue(stubNativeLib({ check: 99 }) as never);
    const state = await contactsProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
  });

  it("check() falls back to TCC granted when the dylib is missing", async () => {
    mockQueryTcc.mockResolvedValue("granted");
    const state = await contactsProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(mockQueryTcc).toHaveBeenCalledTimes(1);
    expect(mockQueryTcc).toHaveBeenCalledWith(
      "kTCCServiceAddressBook",
      BUNDLE_ID,
    );
  });

  it("check() falls back to TCC denied when the dylib is missing", async () => {
    mockQueryTcc.mockResolvedValue("denied");
    const state = await contactsProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(mockQueryTcc).toHaveBeenCalledWith(
      "kTCCServiceAddressBook",
      BUNDLE_ID,
    );
  });

  it("check() treats a missing TCC row as not-determined", async () => {
    mockQueryTcc.mockResolvedValue(null);
    const state = await contactsProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(mockQueryTcc).toHaveBeenCalledWith(
      "kTCCServiceAddressBook",
      BUNDLE_ID,
    );
  });

  it("request() returns platform-unsupported on non-Darwin without prompting", async () => {
    darwin.value = false;
    const state = await contactsProber.request({ reason: "sync contacts" });
    expect(state.status).toBe("not-applicable");
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastRequested).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("request() uses the native prompt and stamps lastRequested", async () => {
    const lib = stubNativeLib({ check: 0, request: 2 });
    mockGetNativeDylib.mockResolvedValue(lib as never);
    const before = Date.now();
    const state = await contactsProber.request({ reason: "sync contacts" });
    const after = Date.now();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
    expect(mockQueryTcc).not.toHaveBeenCalled();
  });

  it("request() without a dylib opens the Contacts privacy pane then re-checks", async () => {
    mockQueryTcc.mockResolvedValue("denied");
    const before = Date.now();
    const state = await contactsProber.request({ reason: "sync contacts" });
    const after = Date.now();
    expect(mockOpenPrivacyPane).toHaveBeenCalledTimes(1);
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("Contacts");
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(mockQueryTcc).toHaveBeenCalledWith(
      "kTCCServiceAddressBook",
      BUNDLE_ID,
    );
  });
});
