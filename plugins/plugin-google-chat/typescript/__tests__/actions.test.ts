import { describe, expect, it } from "vitest";
import { listSpaces, sendMessage, sendReaction } from "../src/actions/index.js";

describe("GoogleChatActions", () => {
  describe("sendMessage", () => {
    describe("metadata", () => {
      it("should have correct action name", () => {
        expect(sendMessage.name).toBe("GOOGLE_CHAT_SEND_MESSAGE");
      });

      it("should have similes including common variations", () => {
        expect(sendMessage.similes).toContain("SEND_GOOGLE_CHAT_MESSAGE");
        expect(sendMessage.similes).toContain("MESSAGE_GOOGLE_CHAT");
        expect(sendMessage.similes).toContain("GCHAT_SEND");
        expect(sendMessage.similes).toContain("GOOGLE_CHAT_TEXT");
      });

      it("should have a non-empty description", () => {
        expect(sendMessage.description).toBeTruthy();
        expect(sendMessage.description.length).toBeGreaterThan(0);
      });

      it("should have examples", () => {
        expect(sendMessage.examples).toBeDefined();
        expect(sendMessage.examples.length).toBeGreaterThan(0);
      });

      it("should have a handler function", () => {
        expect(typeof sendMessage.handler).toBe("function");
      });

      it("should have a validate function", () => {
        expect(typeof sendMessage.validate).toBe("function");
      });
    });

    describe("validate", () => {
      it("should return true for google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "google-chat",
          },
        };
        const result = await sendMessage.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(true);
      });

      it("should return false for non-google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "telegram",
          },
        };
        const result = await sendMessage.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });

      it("should return false for undefined source", async () => {
        const mockMessage = {
          content: {},
        };
        const result = await sendMessage.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });

      it("should return false for discord source", async () => {
        const mockMessage = {
          content: {
            source: "discord",
          },
        };
        const result = await sendMessage.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });
    });
  });

  describe("sendReaction", () => {
    describe("metadata", () => {
      it("should have correct action name", () => {
        expect(sendReaction.name).toBe("GOOGLE_CHAT_SEND_REACTION");
      });

      it("should have similes including common variations", () => {
        expect(sendReaction.similes).toContain("REACT_GOOGLE_CHAT");
        expect(sendReaction.similes).toContain("GCHAT_REACT");
        expect(sendReaction.similes).toContain("GOOGLE_CHAT_EMOJI");
        expect(sendReaction.similes).toContain("ADD_GOOGLE_CHAT_REACTION");
      });

      it("should have a non-empty description", () => {
        expect(sendReaction.description).toBeTruthy();
        expect(sendReaction.description.length).toBeGreaterThan(0);
      });

      it("should have examples", () => {
        expect(sendReaction.examples).toBeDefined();
        expect(sendReaction.examples.length).toBeGreaterThan(0);
      });
    });

    describe("validate", () => {
      it("should return true for google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "google-chat",
          },
        };
        const result = await sendReaction.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(true);
      });

      it("should return false for non-google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "slack",
          },
        };
        const result = await sendReaction.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });

      it("should return false for undefined source", async () => {
        const mockMessage = {
          content: {},
        };
        const result = await sendReaction.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });
    });
  });

  describe("listSpaces", () => {
    describe("metadata", () => {
      it("should have correct action name", () => {
        expect(listSpaces.name).toBe("GOOGLE_CHAT_LIST_SPACES");
      });

      it("should have similes including common variations", () => {
        expect(listSpaces.similes).toContain("LIST_GOOGLE_CHAT_SPACES");
        expect(listSpaces.similes).toContain("GCHAT_SPACES");
        expect(listSpaces.similes).toContain("SHOW_GOOGLE_CHAT_SPACES");
      });

      it("should have a non-empty description", () => {
        expect(listSpaces.description).toBeTruthy();
        expect(listSpaces.description.length).toBeGreaterThan(0);
      });

      it("should have examples", () => {
        expect(listSpaces.examples).toBeDefined();
        expect(listSpaces.examples.length).toBeGreaterThan(0);
      });
    });

    describe("validate", () => {
      it("should return true for google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "google-chat",
          },
        };
        const result = await listSpaces.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(true);
      });

      it("should return false for non-google-chat source", async () => {
        const mockMessage = {
          content: {
            source: "feishu",
          },
        };
        const result = await listSpaces.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });

      it("should return false for undefined source", async () => {
        const mockMessage = {
          content: {},
        };
        const result = await listSpaces.validate(
          {} as never,
          mockMessage as never,
        );
        expect(result).toBe(false);
      });
    });
  });
});
