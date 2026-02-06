import { describe, expect, it } from "vitest";

import linePlugin, {
  LineService,
  chatContextProvider,
  sendFlexMessage,
  sendLocation,
  sendMessage,
  userContextProvider,
} from "../src/index";

describe("LINE plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(linePlugin.name).toBe("line");
    expect(linePlugin.description).toContain("LINE");
    expect(Array.isArray(linePlugin.actions)).toBe(true);
    expect(Array.isArray(linePlugin.providers)).toBe(true);
    expect(Array.isArray(linePlugin.services)).toBe(true);
  });

  it("exports actions, providers, and service", () => {
    expect(sendMessage).toBeDefined();
    expect(sendFlexMessage).toBeDefined();
    expect(sendLocation).toBeDefined();
    expect(chatContextProvider).toBeDefined();
    expect(userContextProvider).toBeDefined();
    expect(LineService).toBeDefined();
  });
});
