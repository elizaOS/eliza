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
    runtime: {
      id,
      getURL: (path: string) => `chrome-extension://${id}/${path}`,
      sendMessage: () => undefined,
    },
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

  it("accepts the extension's installed guide when hosted in a tab", () => {
    stubExtensionId(EXTENSION_ID);

    expect(
      isPrivilegedExtensionSender({
        id: EXTENSION_ID,
        tab: { id: 7 },
        url: `chrome-extension://${EXTENSION_ID}/popup.html`,
      }),
    ).toBe(true);
  });

  it("rejects a content script even though it carries this extension's id", () => {
    stubExtensionId(EXTENSION_ID);

    expect(
      isPrivilegedExtensionSender({
        id: EXTENSION_ID,
        tab: { id: 7 },
        url: "http://localhost:5173/chat",
      }),
    ).toBe(false);
  });

  it("rejects tab senders without a valid URL", () => {
    stubExtensionId(EXTENSION_ID);

    expect(
      isPrivilegedExtensionSender({ id: EXTENSION_ID, tab: { id: 7 } }),
    ).toBe(false);
    expect(
      isPrivilegedExtensionSender({
        id: EXTENSION_ID,
        tab: { id: 7 },
        url: "not a URL",
      }),
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
