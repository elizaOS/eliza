import { describe, expect, it } from "vitest";

import blueBubblesPlugin, {
  BLUEBUBBLES_SERVICE_NAME,
  BlueBubblesService,
  chatContextProvider,
  sendMessageAction,
  sendReactionAction,
} from "../src/index";

describe("BlueBubbles plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(blueBubblesPlugin.name).toBe(BLUEBUBBLES_SERVICE_NAME);
    expect(blueBubblesPlugin.description).toContain("BlueBubbles");
    expect(Array.isArray(blueBubblesPlugin.actions)).toBe(true);
    expect(Array.isArray(blueBubblesPlugin.providers)).toBe(true);
    expect(Array.isArray(blueBubblesPlugin.services)).toBe(true);
  });

  it("exports actions, providers, and service", () => {
    expect(sendMessageAction).toBeDefined();
    expect(sendReactionAction).toBeDefined();
    expect(chatContextProvider).toBeDefined();
    expect(BlueBubblesService).toBeDefined();
  });
});
