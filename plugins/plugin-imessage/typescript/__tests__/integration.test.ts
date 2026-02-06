import { describe, expect, it } from "vitest";

import imessagePlugin, {
  IMessageService,
  chatContextProvider,
  sendMessage,
} from "../src/index";

describe("iMessage plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(imessagePlugin.name).toBe("imessage");
    expect(imessagePlugin.description).toContain("iMessage");
    expect(Array.isArray(imessagePlugin.actions)).toBe(true);
    expect(Array.isArray(imessagePlugin.providers)).toBe(true);
    expect(Array.isArray(imessagePlugin.services)).toBe(true);
  });

  it("exports actions, providers, and service", () => {
    expect(sendMessage).toBeDefined();
    expect(chatContextProvider).toBeDefined();
    expect(IMessageService).toBeDefined();
  });
});
