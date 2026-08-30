// @vitest-environment jsdom

/**
 * Verifies the production seed adapter delegates range completeness to the
 * server-side Gmail and calendar seed use-cases and renders their receipts
 * without recomputing counts. The client is a deterministic double.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { client } = vi.hoisted(() => ({
  client: {
    seedLifeOpsGmail: vi.fn(),
    seedLifeOpsCalendar: vi.fn(),
  },
}));

vi.mock("@elizaos/ui/api", () => ({
  client,
  dispatchNavigateViewEvent: vi.fn(),
}));

import { defaultLifeOpsConnectionsAdapter } from "./adapter.js";

const googleKey = JSON.stringify([
  "google",
  "owner",
  "connector-account:account-a",
  "account-a",
  "primary",
]);
const appleKey = JSON.stringify([
  "apple_calendar",
  "owner",
  "apple-calendar",
  "apple-calendar",
  "apple-work",
]);

describe("LifeOps seed adapter", () => {
  beforeEach(() => {
    client.seedLifeOpsGmail.mockReset();
    client.seedLifeOpsCalendar.mockReset();
  });

  it("reports the server-side complete counts for Gmail and selected calendars", async () => {
    client.seedLifeOpsGmail.mockResolvedValue({ messageCount: 137 });
    client.seedLifeOpsCalendar.mockResolvedValue({
      eventCount: 9,
      duplicateEventCount: 2,
    });
    const phases: string[] = [];

    const receipt = await defaultLifeOpsConnectionsAdapter.seed(
      {
        grantId: "connector-account:account-a",
        rangeDays: 30,
        includeGmail: true,
        calendarKeys: [googleKey, appleKey],
      },
      (phase) => phases.push(phase),
    );

    expect(client.seedLifeOpsGmail).toHaveBeenCalledWith({
      side: "owner",
      mode: "local",
      grantId: "connector-account:account-a",
      rangeDays: 30,
    });
    expect(client.seedLifeOpsCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "owner",
        calendars: [
          {
            provider: "google",
            side: "owner",
            grantId: "connector-account:account-a",
            connectorAccountId: "account-a",
            calendarId: "primary",
          },
          {
            provider: "apple_calendar",
            side: "owner",
            grantId: "apple-calendar",
            connectorAccountId: "apple-calendar",
            calendarId: "apple-work",
          },
        ],
      }),
    );
    expect(receipt).toMatchObject({
      gmailMessageCount: 137,
      calendarEventCount: 9,
      calendarSourceCount: 2,
      duplicateEventCount: 2,
    });
    expect(phases).toEqual([
      "preparing",
      "gmail",
      "calendar",
      "deduplicating",
      "complete",
    ]);
  });

  it("surfaces an incomplete Gmail seed as a failure with no receipt", async () => {
    client.seedLifeOpsGmail.mockRejectedValue(
      new Error("Gmail returned more than 500 pages"),
    );

    await expect(
      defaultLifeOpsConnectionsAdapter.seed(
        {
          grantId: "connector-account:account-a",
          rangeDays: 90,
          includeGmail: true,
          calendarKeys: [googleKey],
        },
        () => undefined,
      ),
    ).rejects.toThrow(/more than 500 pages/);
    expect(client.seedLifeOpsCalendar).not.toHaveBeenCalled();
  });

  it("seeds Apple-only selections without calling Gmail or inventing a grant", async () => {
    client.seedLifeOpsCalendar.mockResolvedValue({
      eventCount: 3,
      duplicateEventCount: 0,
    });

    const receipt = await defaultLifeOpsConnectionsAdapter.seed(
      {
        grantId: null,
        rangeDays: 7,
        includeGmail: false,
        calendarKeys: [appleKey],
      },
      () => undefined,
    );

    expect(client.seedLifeOpsGmail).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      grantId: null,
      gmailMessageCount: 0,
      calendarEventCount: 3,
      calendarSourceCount: 1,
    });
  });
});
