/**
 * Database > Media lists media found in table rows. The rows API returns
 * jsonb columns such as `memories.content` as objects, so the scan walks
 * object values. A string leaf that is itself a media URL or path stays
 * whole; chat prose yields only absolute http(s) URLs.
 */
import { describe, expect, it } from "vitest";
import { extractMediaFromRows } from "../MediaGalleryView";

function urlsOf(content: unknown): string[] {
  return extractMediaFromRows([{ content }], "memories").map((item) => item.url);
}

describe("Media gallery row scan", () => {
  it("does not turn a bare file name in chat text into a gallery item", () => {
    expect(urlsOf({ text: "I saved logo.png" })).toEqual([]);
  });

  it("keeps an attachment path that contains a space whole", () => {
    expect(
      urlsOf({ attachments: [{ url: "/media/My Photos/cat 1.jpg" }] }),
    ).toEqual(["/media/My Photos/cat 1.jpg"]);
  });

  it("keeps a whole media URL leaf", () => {
    expect(
      urlsOf({ attachments: [{ url: "https://cdn.example.com/up/cat.jpg" }] }),
    ).toEqual(["https://cdn.example.com/up/cat.jpg"]);
  });

  it("takes absolute URLs out of chat prose", () => {
    expect(
      urlsOf({
        text: "Your chart is ready: https://cdn.example.com/charts/btc.png. Audio: https://cdn.example.com/a.mp3",
      }),
    ).toEqual([
      "https://cdn.example.com/charts/btc.png",
      "https://cdn.example.com/a.mp3",
    ]);
  });
});

describe("Media gallery memories rows", () => {
  it("lists chat media from content, not from the lowercased search copy", () => {
    // Shape returned by GET /api/database/tables/memories/rows for chat rows.
    const rows = [
      {
        type: "messages",
        content: { text: "I saved logo.png", source: "client_chat" },
        message_search_document: "i saved logo.png ",
      },
      {
        type: "messages",
        content: {
          text: "Attaching a photo of the swatch.",
          attachments: [
            { title: "orange swatch.png", url: "/api/media/22ad.png" },
          ],
        },
        message_search_document:
          "attaching a photo of the swatch. orange swatch.png /api/media/22ad.png",
      },
      {
        type: "messages",
        content: {
          text: "Chart: https://upload.wikimedia.org/a/PNG_Demo_1.png. Thoughts?",
        },
        message_search_document:
          "chart: https://upload.wikimedia.org/a/png_demo_1.png. thoughts?",
      },
    ];
    expect(
      extractMediaFromRows(rows, "memories").map((item) => item.url),
    ).toEqual(["/api/media/22ad.png", "https://upload.wikimedia.org/a/PNG_Demo_1.png"]);
  });
});
