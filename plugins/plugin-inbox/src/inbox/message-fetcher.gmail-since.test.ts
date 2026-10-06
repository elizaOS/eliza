/**
 * fetchGmailMessages must apply sinceIso before the result limit: triage
 * orders by score, not recency, so slicing the newest/limit rows first drops
 * valid in-window messages. Deterministic stub source, no network or database.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchGmailMessages } from "./message-fetcher.js";

function gmailRow(id: string, receivedAt: string) {
  return {
    id,
    externalId: `ext-${id}`,
    receivedAt,
    from: "sender",
    fromEmail: "sender@example.test",
    subject: id,
    snippet: id,
    accountEmail: "owner@example.test",
    grantId: "grant-1",
  };
}

function gmailSource(rows: ReturnType<typeof gmailRow>[]) {
  return {
    getGoogleConnectorStatus: async () => ({
      connected: true,
      grantedCapabilities: ["google.gmail.triage"],
    }),
    getGmailTriage: vi.fn(
      async (_url: URL, request?: { maxResults?: number }) => ({
        messages:
          request?.maxResults === undefined
            ? rows
            : rows.slice(0, request.maxResults),
        source: "synced",
        syncedAt: "2026-07-11T08:00:00.000Z",
        summary: {},
      }),
    ),
  };
}

describe("fetchGmailMessages sinceIso window", () => {
  it("returns an in-window message past a capped out-of-window triage row", async () => {
    const source = gmailSource([
      gmailRow("old-high-triage", "2026-01-01T00:00:00.000Z"),
      gmailRow("new-valid", "2026-07-11T07:00:00.000Z"),
    ]);

    const result = await fetchGmailMessages(source as never, {
      limit: 1,
      sinceIso: "2026-06-01T00:00:00.000Z",
    });

    expect(result.messages.map((message) => message.text)).toEqual([
      "new-valid",
    ]);
  });

  it("does not cap the triage read when filtering by sinceIso", async () => {
    const source = gmailSource([
      gmailRow("old-high-triage", "2026-01-01T00:00:00.000Z"),
      gmailRow("new-valid", "2026-07-11T07:00:00.000Z"),
    ]);

    await fetchGmailMessages(source as never, {
      limit: 1,
      sinceIso: "2026-06-01T00:00:00.000Z",
    });

    expect(source.getGmailTriage).toHaveBeenCalledWith(
      expect.any(URL),
      expect.not.objectContaining({ maxResults: expect.anything() }),
    );
  });

  it("still caps the triage read when no sinceIso is given", async () => {
    const source = gmailSource([
      gmailRow("first", "2026-07-11T07:00:00.000Z"),
      gmailRow("second", "2026-07-11T06:00:00.000Z"),
    ]);

    const result = await fetchGmailMessages(source as never, { limit: 1 });

    expect(result.messages.map((message) => message.text)).toEqual(["first"]);
    expect(source.getGmailTriage).toHaveBeenCalledWith(expect.any(URL), {
      maxResults: 1,
    });
  });
});
