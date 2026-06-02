import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import {
  MESSAGES_APP_NAME,
  messagesApp,
  registerMessagesApp,
} from "./messages-app";

describe("messages overlay registration", () => {
  it("describes an Android-only messages overlay app", () => {
    expect(messagesApp).toMatchObject({
      name: MESSAGES_APP_NAME,
      displayName: "Messages",
      description: "SMS inbox, threads, and compose for Android",
      category: "system",
      androidOnly: true,
    });
    expect(messagesApp.loader).toEqual(expect.any(Function));
  });

  it("registers the exported overlay descriptor", () => {
    registerMessagesApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(messagesApp);
  });
});
