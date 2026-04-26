import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleGmailTriageMessages } from "./google-gmail.js";

describe("fetchGoogleGmailTriageMessages", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function metadata(id: string, receivedAt: string) {
    return {
      id,
      threadId: `thread-${id}`,
      labelIds: ["INBOX", "UNREAD"],
      snippet: `snippet ${id}`,
      internalDate: String(Date.parse(receivedAt)),
      payload: {
        headers: [
          { name: "Subject", value: `Subject ${id}` },
          { name: "From", value: `Sender ${id} <sender-${id}@example.test>` },
          { name: "To", value: "owner@example.test" },
        ],
      },
    };
  }

  it("paginates Gmail list calls and fetches metadata for every requested page", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/messages")) {
        const pageToken = parsed.searchParams.get("pageToken");
        return new Response(
          JSON.stringify(
            pageToken === "page-2"
              ? { messages: [{ id: "m3" }] }
              : {
                  messages: [{ id: "m1" }, { id: "m2" }],
                  nextPageToken: "page-2",
                },
          ),
          { status: 200 },
        );
      }
      const id = parsed.pathname.split("/").pop() ?? "unknown";
      return new Response(
        JSON.stringify(metadata(id, `2026-04-21T12:0${id.slice(1)}:00.000Z`)),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const messages = await fetchGoogleGmailTriageMessages({
      accessToken: "token",
      selfEmail: "owner@example.test",
      maxResults: 3,
    });

    expect(messages.map((message) => message.externalId).sort()).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    const listUrls = calls
      .map((url) => new URL(url))
      .filter((url) => url.pathname.endsWith("/messages"));
    expect(listUrls).toHaveLength(2);
    expect(listUrls[0]?.searchParams.get("maxResults")).toBe("3");
    expect(listUrls[0]?.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
    expect(listUrls[1]?.searchParams.get("maxResults")).toBe("1");
    expect(listUrls[1]?.searchParams.get("pageToken")).toBe("page-2");
  });

  it("uses Gmail's 500-message page size when warming a large cache window", async () => {
    const listUrls: URL[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith("/messages")) {
        listUrls.push(parsed);
        return new Response(
          JSON.stringify(
            parsed.searchParams.get("pageToken")
              ? { messages: [{ id: "m501" }] }
              : {
                  messages: Array.from({ length: 500 }, (_, index) => ({
                    id: `m${index + 1}`,
                  })),
                  nextPageToken: "page-2",
                },
          ),
          { status: 200 },
        );
      }
      const id = parsed.pathname.split("/").pop() ?? "unknown";
      return new Response(
        JSON.stringify(metadata(id, "2026-04-21T12:00:00.000Z")),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await fetchGoogleGmailTriageMessages({
      accessToken: "token",
      selfEmail: "owner@example.test",
      maxResults: 501,
    });

    expect(listUrls).toHaveLength(2);
    expect(listUrls[0]?.searchParams.get("maxResults")).toBe("500");
    expect(listUrls[1]?.searchParams.get("maxResults")).toBe("1");
    expect(listUrls[1]?.searchParams.get("pageToken")).toBe("page-2");
  });
});
