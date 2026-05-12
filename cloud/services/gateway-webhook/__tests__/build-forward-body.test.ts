import { describe, expect, test } from "bun:test";
import { buildForwardBody, type ForwardMessageOptions } from "../src/server-router";

describe("buildForwardBody", () => {
  test("returns only userId and text when options are omitted", () => {
    const body = buildForwardBody("user-001", "Hello");
    expect(body).toEqual({ userId: "user-001", text: "Hello" });
  });

  test("includes all metadata fields when all options are provided", () => {
    const options: ForwardMessageOptions = {
      platformName: "telegram",
      senderName: "Alice",
      chatId: "42",
    };
    const body = buildForwardBody("user-001", "Hello", options);
    expect(body).toEqual({
      userId: "user-001",
      text: "Hello",
      platformName: "telegram",
      senderName: "Alice",
      chatId: "42",
    });
  });

  test("omits senderName when it is undefined", () => {
    const body = buildForwardBody("user-001", "Hello", {
      platformName: "twilio",
      chatId: "+15551234567",
    });
    expect(body.platformName).toBe("twilio");
    expect(body.chatId).toBe("+15551234567");
    expect("senderName" in body).toBe(false);
  });

  test("omits chatId and senderName when only platformName is set", () => {
    const body = buildForwardBody("user-001", "Hi", { platformName: "blooio" });
    expect(body.platformName).toBe("blooio");
    expect("senderName" in body).toBe(false);
    expect("chatId" in body).toBe(false);
  });

  test("returns only userId and text when options object is empty", () => {
    const body = buildForwardBody("user-001", "Hello", {});
    expect(body).toEqual({ userId: "user-001", text: "Hello" });
  });

  test("omits fields with empty-string values", () => {
    const body = buildForwardBody("user-001", "Hi", {
      platformName: "",
      senderName: "",
      chatId: "",
    });
    expect(body).toEqual({ userId: "user-001", text: "Hi" });
  });
});
