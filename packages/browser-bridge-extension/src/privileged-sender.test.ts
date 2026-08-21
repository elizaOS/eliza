/**
 * The background's runtime.onMessage channel dispatches credential writes
 * (`browser-bridge:save-config`). Content scripts share that channel and this
 * extension's run on `http://localhost/*` at any port — i.e. any local dev
 * server the user happens to be running — so the sender has to be checked
 * before the message is dispatched.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { isPrivilegedExtensionSender } from "./webextension.ts";

const EXTENSION_ID = "abcdefghijklmnopqrstuvwxyzabcdef";

function stubExtensionId(id: string | undefined): void {
  vi.stubGlobal("chrome", {
    runtime: { id, sendMessage: () => undefined },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPrivilegedExtensionSender", () => {
  it("accepts the extension's own popup", () => {
    stubExtensionId(EXTENSION_ID);

    expect(isPrivilegedExtensionSender({ id: EXTENSION_ID })).toBe(true);
  });

  it("rejects a content script, which carries a tab", () => {
    stubExtensionId(EXTENSION_ID);

    expect(
      isPrivilegedExtensionSender({ id: EXTENSION_ID, tab: { id: 7 } }),
    ).toBe(false);
  });

  it("rejects another extension", () => {
    stubExtensionId(EXTENSION_ID);

    expect(isPrivilegedExtensionSender({ id: "some-other-extension" })).toBe(
      false,
    );
  });

  // Fail closed: if the runtime cannot tell us our own id, we cannot prove the
  // sender is privileged, so nothing is privileged.
  it("rejects everything when the extension id is unavailable", () => {
    stubExtensionId(undefined);

    expect(isPrivilegedExtensionSender({ id: EXTENSION_ID })).toBe(false);
  });

  it("rejects malformed senders", () => {
    stubExtensionId(EXTENSION_ID);

    expect(isPrivilegedExtensionSender(undefined)).toBe(false);
    expect(isPrivilegedExtensionSender("popup")).toBe(false);
    expect(isPrivilegedExtensionSender({})).toBe(false);
  });
});
