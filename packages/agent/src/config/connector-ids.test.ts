import { CONNECTOR_IDS as SHARED_CONNECTOR_IDS } from "@elizaos/shared/config/schema";
import { describe, expect, test } from "vitest";

import { CONNECTOR_IDS as AGENT_CONNECTOR_IDS } from "./schema.ts";

describe("CONNECTOR_IDS", () => {
  test("agent re-exports the shared connector id list", () => {
    expect(AGENT_CONNECTOR_IDS).toBe(SHARED_CONNECTOR_IDS);
  });

  test("includes connector ids that drifted out of the shared copy", () => {
    expect(AGENT_CONNECTOR_IDS).toEqual(
      expect.arrayContaining([
        "matrix",
        "nostr",
        "blooio",
        "twitch",
        "mattermost",
        "googlechat",
      ]),
    );
  });
});
