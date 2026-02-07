import { describe, expect, it } from "vitest";
import googleChatPlugin, {
  GoogleChatService,
  listSpaces,
  sendMessage,
  sendReaction,
  spaceStateProvider,
  userContextProvider,
} from "../src/index.js";

describe("GoogleChatPlugin", () => {
  describe("plugin definition", () => {
    it("should have the correct name", () => {
      expect(googleChatPlugin.name).toBe("google-chat");
    });

    it("should have a non-empty description", () => {
      expect(googleChatPlugin.description).toBeTruthy();
      expect(googleChatPlugin.description!.length).toBeGreaterThan(0);
    });

    it("should include the GoogleChatService in services", () => {
      expect(googleChatPlugin.services).toBeDefined();
      expect(googleChatPlugin.services).toContain(GoogleChatService);
    });

    it("should include all three actions", () => {
      expect(googleChatPlugin.actions).toBeDefined();
      expect(googleChatPlugin.actions).toContain(sendMessage);
      expect(googleChatPlugin.actions).toContain(sendReaction);
      expect(googleChatPlugin.actions).toContain(listSpaces);
      expect(googleChatPlugin.actions!.length).toBe(3);
    });

    it("should include both providers", () => {
      expect(googleChatPlugin.providers).toBeDefined();
      expect(googleChatPlugin.providers).toContain(spaceStateProvider);
      expect(googleChatPlugin.providers).toContain(userContextProvider);
      expect(googleChatPlugin.providers!.length).toBe(2);
    });

    it("should have an empty tests array", () => {
      expect(googleChatPlugin.tests).toBeDefined();
      expect(googleChatPlugin.tests).toEqual([]);
    });

    it("should have an init function", () => {
      expect(typeof googleChatPlugin.init).toBe("function");
    });
  });

  describe("exports", () => {
    it("should export GoogleChatService", () => {
      expect(GoogleChatService).toBeDefined();
    });

    it("should export all actions", () => {
      expect(sendMessage).toBeDefined();
      expect(sendReaction).toBeDefined();
      expect(listSpaces).toBeDefined();
    });

    it("should export all providers", () => {
      expect(spaceStateProvider).toBeDefined();
      expect(userContextProvider).toBeDefined();
    });
  });
});
