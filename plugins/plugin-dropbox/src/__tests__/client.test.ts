/**
 * DropboxClient contract tests against a deterministic, protocol-faithful fake
 * Dropbox API v2 (real RPC/content wire shapes served through an injected
 * fetch). Covers success, designed-empty, cursor pagination
 * (list_folder/continue and search/continue_v2), expired auth, rate limiting,
 * 409 path errors, malformed upstream data, upstream failure, the text-read
 * limitation UX (binary and oversized refusals), uploads, and deep links.
 */
import type { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  DROPBOX_MAX_TEXT_BYTES,
  DropboxClient,
  dropboxApiArg,
  dropboxDeepLink,
} from "../client.js";
import type { DropboxCredentialResolver } from "../types.js";

const resolver: DropboxCredentialResolver = {
  getCredential: async () => ({ accessToken: "sl.test_token" }),
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: BodyInit | null | undefined;
}

function fakeDropbox(
  handler: (request: RecordedRequest) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    raw?: BodyInit;
  }
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    );
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" && headers["content-type"]?.includes("json")
          ? JSON.parse(init.body)
          : undefined,
      rawBody: init?.body,
    };
    requests.push(request);
    const result = handler(request);
    if (result.raw !== undefined) {
      return new Response(result.raw, { status: result.status, headers: result.headers });
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json", ...result.headers },
    });
  };
  return { fetchImpl, requests };
}

function fileEntry(name: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    ".tag": "file",
    id: `id:${name}`,
    name,
    path_lower: path.toLowerCase(),
    path_display: path,
    size: 128,
    client_modified: "2026-08-01T00:00:00Z",
    server_modified: "2026-08-02T00:00:00Z",
    content_hash: "abc123",
    ...extra,
  };
}

function client(fetchImpl: typeof fetch): DropboxClient {
  return new DropboxClient(resolver, {
    apiBaseUrl: "https://api.dropbox.test",
    contentBaseUrl: "https://content.dropbox.test",
    fetchImpl,
  });
}

describe("DropboxClient.listFolder", () => {
  it("lists a folder with bearer auth and maps entries with deep links", async () => {
    const { fetchImpl, requests } = fakeDropbox(() => ({
      status: 200,
      body: {
        entries: [
          fileEntry("q3.pdf", "/Reports/q3.pdf"),
          {
            ".tag": "folder",
            id: "id:folder",
            name: "Archive",
            path_lower: "/reports/archive",
            path_display: "/Reports/Archive",
          },
        ],
        cursor: "cursor-a",
        has_more: false,
      },
    }));
    const page = await client(fetchImpl).listFolder({ accountId: "acct", path: "/Reports" });
    expect(requests[0].url).toBe("https://api.dropbox.test/2/files/list_folder");
    expect(requests[0].headers.authorization).toBe("Bearer sl.test_token");
    expect((requests[0].body as { path: string }).path).toBe("/Reports");
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0].kind).toBe("file");
    expect(page.entries[0].url).toBe("https://www.dropbox.com/home/Reports?preview=q3.pdf");
    expect(page.entries[1].kind).toBe("folder");
    expect(page.entries[1].url).toBe("https://www.dropbox.com/home/Reports/Archive");
  });

  it("continues with the cursor endpoint when a cursor is supplied", async () => {
    const { fetchImpl, requests } = fakeDropbox(() => ({
      status: 200,
      body: { entries: [], cursor: null, has_more: false },
    }));
    const page = await client(fetchImpl).listFolder({ accountId: "acct", cursor: "cursor-a" });
    expect(requests[0].url).toBe("https://api.dropbox.test/2/files/list_folder/continue");
    expect((requests[0].body as { cursor: string }).cursor).toBe("cursor-a");
    expect(page.entries).toEqual([]);
  });

  it("maps 401 to DROPBOX_AUTH_EXPIRED even with a non-JSON body", async () => {
    const { fetchImpl } = fakeDropbox(() => ({
      status: 401,
      raw: "Error in call to API function: invalid access token",
    }));
    const error = await client(fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_AUTH_EXPIRED");
  });

  it("maps 429 with a retry_after body to DROPBOX_RATE_LIMITED", async () => {
    const { fetchImpl } = fakeDropbox(() => ({
      status: 429,
      body: {
        error_summary: "too_many_requests/",
        error: { reason: { ".tag": "too_many_requests" }, retry_after: 30 },
      },
    }));
    const error = await client(fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_RATE_LIMITED");
    expect((error as ElizaError).context?.retryAfterSeconds).toBe(30);
  });

  it("maps a 409 path not_found to DROPBOX_NOT_FOUND", async () => {
    const { fetchImpl } = fakeDropbox(() => ({
      status: 409,
      body: {
        error_summary: "path/not_found/..",
        error: { ".tag": "path", path: { ".tag": "not_found" } },
      },
    }));
    const error = await client(fetchImpl)
      .getMetadata({ accountId: "acct", path: "/missing" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_NOT_FOUND");
  });

  it("maps 5xx to DROPBOX_UPSTREAM_FAILURE and rejects malformed success bodies", async () => {
    const down = fakeDropbox(() => ({ status: 503, raw: "upstream down" }));
    const e1 = await client(down.fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e);
    expect((e1 as ElizaError).code).toBe("DROPBOX_UPSTREAM_FAILURE");

    const malformed = fakeDropbox(() => ({ status: 200, body: { cursor: "x" } }));
    const e2 = await client(malformed.fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e);
    expect((e2 as ElizaError).code).toBe("DROPBOX_MALFORMED_RESPONSE");
  });
});

describe("DropboxClient.search", () => {
  it("searches then continues via search/continue_v2 with the returned cursor", async () => {
    const { fetchImpl, requests } = fakeDropbox((request) => {
      if (request.url.endsWith("/2/files/search_v2")) {
        return {
          status: 200,
          body: {
            matches: [{ metadata: { ".tag": "metadata", metadata: fileEntry("a.txt", "/a.txt") } }],
            cursor: "search-cursor",
            has_more: true,
          },
        };
      }
      return {
        status: 200,
        body: {
          matches: [{ metadata: { ".tag": "metadata", metadata: fileEntry("b.txt", "/b.txt") } }],
          cursor: null,
          has_more: false,
        },
      };
    });
    const c = client(fetchImpl);
    const first = await c.search({ accountId: "acct", query: "txt" });
    expect(first.hasMore).toBe(true);
    expect(first.entries[0].name).toBe("a.txt");
    const second = await c.search({ accountId: "acct", query: "txt", cursor: first.cursor ?? "" });
    expect(requests[1].url).toBe("https://api.dropbox.test/2/files/search/continue_v2");
    expect(second.entries[0].name).toBe("b.txt");
    expect(second.hasMore).toBe(false);
  });

  it("returns a designed-empty result when nothing matches", async () => {
    const { fetchImpl } = fakeDropbox(() => ({
      status: 200,
      body: { matches: [], has_more: false },
    }));
    const page = await client(fetchImpl).search({ accountId: "acct", query: "nothing" });
    expect(page.entries).toEqual([]);
    expect(page.cursor).toBeNull();
  });
});

describe("DropboxClient content endpoints", () => {
  it("downloads UTF-8 text through the content host with Dropbox-API-Arg", async () => {
    const { fetchImpl, requests } = fakeDropbox((request) => {
      if (request.url.includes("get_metadata")) {
        return { status: 200, body: fileEntry("notes.md", "/notes.md", { size: 11 }) };
      }
      return { status: 200, raw: "hello world" };
    });
    const result = await client(fetchImpl).downloadText({ accountId: "acct", path: "/notes.md" });
    expect(result.text).toBe("hello world");
    expect(requests[1].url).toBe("https://content.dropbox.test/2/files/download");
    expect(JSON.parse(requests[1].headers["dropbox-api-arg"])).toEqual({ path: "/notes.md" });
  });

  it("refuses binary content with DROPBOX_FILE_NOT_TEXT", async () => {
    const { fetchImpl } = fakeDropbox((request) => {
      if (request.url.includes("get_metadata")) {
        return { status: 200, body: fileEntry("app.bin", "/app.bin", { size: 4 }) };
      }
      return { status: 200, raw: new Uint8Array([0x00, 0x01, 0x02, 0x03]) };
    });
    const error = await client(fetchImpl)
      .downloadText({ accountId: "acct", path: "/app.bin" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_FILE_NOT_TEXT");
  });

  it("refuses oversized files before downloading", async () => {
    const { fetchImpl, requests } = fakeDropbox(() => ({
      status: 200,
      body: fileEntry("big.log", "/big.log", { size: DROPBOX_MAX_TEXT_BYTES + 1 }),
    }));
    const error = await client(fetchImpl)
      .downloadText({ accountId: "acct", path: "/big.log" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_FILE_TOO_LARGE");
    expect(requests).toHaveLength(1);
  });

  it("accepts the exact text cap without reading a max+1 byte", async () => {
    const bytes = new Uint8Array(DROPBOX_MAX_TEXT_BYTES).fill(0x61);
    const { fetchImpl } = fakeDropbox((request) => {
      if (request.url.includes("get_metadata")) {
        return {
          status: 200,
          body: fileEntry("exact.txt", "/exact.txt", { size: DROPBOX_MAX_TEXT_BYTES }),
        };
      }
      return { status: 200, raw: bytes };
    });
    const result = await client(fetchImpl).downloadText({ accountId: "acct", path: "/exact.txt" });
    expect(result.text).toHaveLength(DROPBOX_MAX_TEXT_BYTES);
  });

  it("cancels a dishonest max+1 stream and reports DROPBOX_FILE_TOO_LARGE", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("get_metadata")) {
        return new Response(
          JSON.stringify(fileEntry("dishonest.txt", "/dishonest.txt", { size: 1 })),
          { status: 200 }
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(DROPBOX_MAX_TEXT_BYTES + 1).fill(0x61));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Length": "1" } });
    };
    const error = await client(fetchImpl)
      .downloadText({ accountId: "acct", path: "/dishonest.txt" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_FILE_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled download at the body deadline", async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("get_metadata")) {
        return new Response(JSON.stringify(fileEntry("stalled.txt", "/stalled.txt", { size: 1 })), {
          status: 200,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 }
      );
    };
    const c = new DropboxClient(resolver, {
      apiBaseUrl: "https://api.dropbox.test",
      contentBaseUrl: "https://content.dropbox.test",
      fetchImpl,
      timeoutMs: 5,
    });
    const error = await c
      .downloadText({ accountId: "acct", path: "/stalled.txt" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_UPSTREAM_FAILURE");
    expect(cancelled).toBe(true);
  });

  it("rejects malformed UTF-8 as non-text", async () => {
    const { fetchImpl } = fakeDropbox((request) => {
      if (request.url.includes("get_metadata")) {
        return { status: 200, body: fileEntry("bad.txt", "/bad.txt", { size: 2 }) };
      }
      return { status: 200, raw: new Uint8Array([0xc3, 0x28]) };
    });
    const error = await client(fetchImpl)
      .downloadText({ accountId: "acct", path: "/bad.txt" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_FILE_NOT_TEXT");
  });

  it("uploads bytes with mode and returns the mapped entry", async () => {
    const { fetchImpl, requests } = fakeDropbox(() => ({
      status: 200,
      body: { ...fileEntry("out.txt", "/out.txt"), ".tag": undefined },
    }));
    const entry = await client(fetchImpl).upload({
      accountId: "acct",
      path: "/out.txt",
      content: "data",
      mode: "overwrite",
    });
    const arg = JSON.parse(requests[0].headers["dropbox-api-arg"]) as { mode: string };
    expect(arg.mode).toBe("overwrite");
    expect(requests[0].headers["content-type"]).toBe("application/octet-stream");
    expect(entry.name).toBe("out.txt");
    expect(entry.kind).toBe("file");
  });

  it("returns the temporary link and rejects a linkless payload", async () => {
    const good = fakeDropbox(() => ({
      status: 200,
      body: { metadata: fileEntry("a.txt", "/a.txt"), link: "https://dl.dropbox.test/tmp/a" },
    }));
    await expect(
      client(good.fetchImpl).getTemporaryLink({ accountId: "acct", path: "/a.txt" })
    ).resolves.toBe("https://dl.dropbox.test/tmp/a");

    const bad = fakeDropbox(() => ({ status: 200, body: { metadata: {} } }));
    const error = await client(bad.fetchImpl)
      .getTemporaryLink({ accountId: "acct", path: "/a.txt" })
      .catch((e: unknown) => e);
    expect((error as ElizaError).code).toBe("DROPBOX_MALFORMED_RESPONSE");
  });
});

describe("helpers", () => {
  it("escapes non-ASCII in Dropbox-API-Arg", () => {
    expect(dropboxApiArg({ path: "/résumé.txt" })).not.toMatch(/[^\x20-\x7e]/);
    expect(JSON.parse(dropboxApiArg({ path: "/résumé.txt" }))).toEqual({ path: "/résumé.txt" });
  });

  it("builds browse links for folders and preview links for files", () => {
    expect(dropboxDeepLink("/A B/c.txt", "file")).toBe(
      "https://www.dropbox.com/home/A%20B?preview=c.txt"
    );
    expect(dropboxDeepLink("/A B", "folder")).toBe("https://www.dropbox.com/home/A%20B");
    expect(dropboxDeepLink("", "folder")).toBe("https://www.dropbox.com/home");
  });
});
