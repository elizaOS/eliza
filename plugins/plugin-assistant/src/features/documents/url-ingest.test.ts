/**
 * Covers numeric HTML-entity decoding in the URL-import plain-text path.
 * Reviewer request on #34465: assert hex (&#x27;), decimal (&#8217;), and an
 * out-of-range reference that must pass through unchanged.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "93.184.216.34", family: 4 })),
}));

import {
  __documentUrlPinnedRequestForTests,
  __setDocumentUrlBodyDeadlinesForTests,
  __setDocumentUrlFetchImplForTests,
  fetchDocumentFromUrl,
} from "./url-ingest.ts";

beforeEach(() => {
  __setDocumentUrlFetchImplForTests(
    async () =>
      new Response(
        "<html><body><p>It&#x27;s &#8217;snowing&#8217; &#8211; end. Keep &#0; and &#xD800; and &#1114112;.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
  );
});

afterEach(() => {
  __setDocumentUrlFetchImplForTests(null);
});

describe("url-ingest numeric HTML entities", () => {
  it("decodes hex and decimal references and leaves out-of-range refs intact", async () => {
    const doc = await fetchDocumentFromUrl(
      "https://example.com/entity-check.html",
    );
    expect(doc.contentType).toBe("html");
    expect(doc.content).toContain("It's");
    expect(doc.content).toContain("\u2019snowing\u2019");
    expect(doc.content).toContain("\u2013 end");
    expect(doc.content).toContain("&#0;");
    expect(doc.content).toContain("&#xD800;");
    expect(doc.content).toContain("&#1114112;");
    expect(doc.content).not.toContain("&#x27;");
    expect(doc.content).not.toContain("&#8217;");
  });
});

describe("url-ingest response charset", () => {
  it("decodes the body with the Content-Type charset", async () => {
    const pages: Array<[string, number[], string]> = [
      // "Café crème" in ISO-8859-1
      [
        "text/html; charset=ISO-8859-1",
        [0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65],
        "Café crème",
      ],
      // "日本語" in Shift_JIS
      [
        "text/plain; charset=Shift_JIS",
        [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea],
        "日本語",
      ],
    ];
    for (const [contentType, bytes, expected] of pages) {
      __setDocumentUrlFetchImplForTests(
        async () =>
          new Response(Uint8Array.from(bytes), {
            status: 200,
            headers: { "content-type": contentType },
          }),
      );
      const doc = await fetchDocumentFromUrl("https://example.com/page");
      expect(doc.content.trim()).toBe(expected);
    }
  });
});

describe("url-ingest MIME classification", () => {
  function serve(body: BodyInit, contentType: string) {
    __setDocumentUrlFetchImplForTests(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        }),
    );
  }

  it("stores an Excel workbook as base64 binary", async () => {
    const bytes = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]);
    serve(bytes, "application/vnd.ms-excel");
    const doc = await fetchDocumentFromUrl("https://example.com/report.xls");
    expect(doc.contentType).toBe("binary");
    expect(doc.contentEncoding).toBe("base64");
    expect(Buffer.from(doc.content, "base64")).toEqual(Buffer.from(bytes));
  });

  it("ingests an HTML login page served at a .pdf URL as HTML", async () => {
    serve("<html><body><p>Please sign in</p></body></html>", "text/html");
    const doc = await fetchDocumentFromUrl("https://example.com/paper.pdf");
    expect(doc.contentType).toBe("html");
    expect(doc.contentEncoding).toBe("utf8");
    expect(doc.filename).toBe("paper.html");
    expect(doc.content).toBe("Please sign in");
  });

  it("rejects audio with a clear message", async () => {
    serve(Uint8Array.from([0xff, 0xfb]), "audio/mpeg");
    await expect(
      fetchDocumentFromUrl("https://example.com/song.mp3"),
    ).rejects.toThrow("Can't import audio/mpeg files from a URL");
  });
});

describe("url-ingest body deadline", () => {
  let server: http.Server;
  let port: number;
  let stallClosed: Promise<void>;

  beforeEach(async () => {
    __setDocumentUrlBodyDeadlinesForTests({ idleMs: 300, totalMs: 3_000 });
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      if (req.url === "/stall") {
        stallClosed = new Promise((resolve) =>
          req.socket.once("close", resolve),
        );
        res.write("partial");
        return;
      }
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        res.write(`chunk${sent} `);
        if (sent === 8) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
    // Send the real pinned request to the local server instead of the
    // public address the URL resolved to.
    __setDocumentUrlFetchImplForTests((input) =>
      __documentUrlPinnedRequestForTests({
        ...input,
        url: new URL(`http://127.0.0.1:${port}${input.url.pathname}`),
        target: {
          ...input.target,
          hostname: "127.0.0.1",
          pinnedAddress: "127.0.0.1",
        },
      }),
    );
  });

  afterEach(async () => {
    __setDocumentUrlBodyDeadlinesForTests(null);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fails a body that stalls after headers", async () => {
    const started = Date.now();
    await expect(
      fetchDocumentFromUrl("https://example.com/stall"),
    ).rejects.toThrow(/stalled/);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The client tore the socket down rather than leaving it open.
    await stallClosed;
  });

  it("keeps a slow body alive while bytes keep arriving", async () => {
    const doc = await fetchDocumentFromUrl("https://example.com/slow");
    expect(doc.content).toContain("chunk8");
  });
});
