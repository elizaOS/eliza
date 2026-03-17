import { describe, expect, it } from "vitest";

import mattermostPlugin, {
  CHAT_STATE_PROVIDER,
  chatStateProvider,
  MATTERMOST_SERVICE_NAME,
  MattermostService,
  SEND_MESSAGE_ACTION,
  sendMessageAction,
} from "../src/index";

describe("Mattermost plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(mattermostPlugin.name).toBe(MATTERMOST_SERVICE_NAME);
    expect(mattermostPlugin.description).toContain("Mattermost");
    expect(Array.isArray(mattermostPlugin.actions)).toBe(true);
    expect(Array.isArray(mattermostPlugin.providers)).toBe(true);
    expect(Array.isArray(mattermostPlugin.services)).toBe(true);
  });

  it("exports actions, providers, and service", () => {
    expect(sendMessageAction).toBeDefined();
    expect(SEND_MESSAGE_ACTION).toBeDefined();
    expect(chatStateProvider).toBeDefined();
    expect(CHAT_STATE_PROVIDER).toBeDefined();
    expect(MattermostService).toBeDefined();
  });
});
