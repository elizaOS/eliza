/**
 * Unit tests for owner contact configuration helpers.
 */

import { describe, expect, it } from "vitest";
import { setOwnerContact } from "./owner-contact-helpers.js";

describe("setOwnerContact", () => {
  it("returns false when source is missing or empty", () => {
    const config = {};
    expect(setOwnerContact(config, { source: "" })).toBe(false);
    // @ts-expect-error test undefined source
    expect(setOwnerContact(config, { source: undefined })).toBe(false);
  });

  it("initializes nested config path and populates contact entry", () => {
    const config: Record<string, unknown> = {};

    const modified = setOwnerContact(config, {
      source: "telegram",
      channelId: "12345678",
      entityId: "uuid-1234",
      roomId: "room-5678",
    });

    expect(modified).toBe(true);
    expect(config).toEqual({
      agents: {
        defaults: {
          ownerContacts: {
            telegram: {
              channelId: "12345678",
              entityId: "uuid-1234",
              roomId: "room-5678",
            },
          },
        },
      },
    });
  });

  it("does not write empty contact updates and returns false", () => {
    const config: Record<string, unknown> = {};
    const modified = setOwnerContact(config, {
      source: "whatsapp",
    });

    expect(modified).toBe(false);
    expect(
      (config as { agents?: { defaults?: { ownerContacts?: unknown } } }).agents
        ?.defaults?.ownerContacts,
    ).toEqual({});
  });

  it("returns false when contact fields are identical to existing entry", () => {
    const config = {
      agents: {
        defaults: {
          ownerContacts: {
            discord: {
              channelId: "987654",
              entityId: "user-1",
            },
          },
        },
      },
    };

    const modified = setOwnerContact(config, {
      source: "discord",
      channelId: "987654",
      entityId: "user-1",
    });

    expect(modified).toBe(false);
  });

  it("updates existing contact entry and returns true when changed", () => {
    const config = {
      agents: {
        defaults: {
          ownerContacts: {
            discord: {
              channelId: "987654",
              entityId: "user-1",
            },
          },
        },
      },
    };

    const modified = setOwnerContact(config, {
      source: "discord",
      channelId: "987654",
      entityId: "user-1",
      roomId: "new-room-id",
    });

    expect(modified).toBe(true);
    expect(config.agents.defaults.ownerContacts.discord).toEqual({
      channelId: "987654",
      entityId: "user-1",
      roomId: "new-room-id",
    });
  });
});
