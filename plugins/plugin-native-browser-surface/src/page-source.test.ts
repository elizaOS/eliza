/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PAGE_SOURCE_BYTES,
  pageSourceExcerpt,
  readPublicPageSource,
} from "./page-source";

function respond(
  body: string,
  type = "text/html; charset=utf-8",
  init: { status?: number; length?: number } = {},
) {
  const headers: Record<string, string> = { "content-type": type };
  if (init.length !== undefined)
    headers["content-length"] = String(init.length);
  return vi.fn(
    async () =>
      new Response(new TextEncoder().encode(body), {
        status: init.status ?? 200,
        headers,
      }),
  );
}

const live = () => new AbortController().signal;

describe("readPublicPageSource", () => {
  it("fetches without credentials, cookies, referrer or redirects", async () => {
    const fetch = respond("<main><p>Hello</p></main>");
    await readPublicPageSource("https://example.com/a", live(), { fetch });
    const [address, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(address).toBe("https://example.com/a");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      mode: "cors",
    });
  });

  it("keeps the main region's text and drops chrome, forms and hidden nodes", async () => {
    const fetch = respond(
      `<html><head><title>T</title></head><body><nav>Menu</nav><header>Top</header>
       <main><h1>Title</h1><p>First   paragraph.</p><p hidden>Hidden</p>
       <div style="display:none">Gone</div><script>evil()</script><p>Second<br>line</p></main>
       <footer>Foot</footer></body></html>`,
    );
    const result = await readPublicPageSource("https://example.com/", live(), {
      fetch,
    });
    expect(result).toEqual({
      text: "Title\n\nFirst paragraph.\n\nSecond\nline",
      truncated: false,
    });
  });

  it("blocks sign-in pages and sensitive addresses without fetching", async () => {
    const fetch = respond("<p>x</p>");
    expect(
      await readPublicPageSource("https://accounts.google.com/", live(), {
        fetch,
      }),
    ).toEqual({ blocked: true });
    expect(fetch).not.toHaveBeenCalled();
    const login = respond(
      '<form><input type="password"></form><p>Enter your password</p>',
    );
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: login,
      }),
    ).toEqual({ blocked: true });
  });

  it("blocks oversized bodies and sensitive plain text", async () => {
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: respond("x", "text/html", { length: MAX_PAGE_SOURCE_BYTES + 1 }),
      }),
    ).toEqual({ blocked: true });
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: respond("x".repeat(MAX_PAGE_SOURCE_BYTES + 1), "text/plain"),
      }),
    ).toEqual({ blocked: true });
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: respond("Your verification code is 123456", "text/plain"),
      }),
    ).toEqual({ blocked: true });
  });

  it("offers nothing for other types, errors, failures and non-web addresses", async () => {
    const image = respond("x", "image/png");
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: image,
      }),
    ).toBeUndefined();
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: respond("<p>x</p>", "text/html", { status: 404 }),
      }),
    ).toBeUndefined();
    expect(
      await readPublicPageSource("https://example.com/", live(), {
        fetch: vi.fn(async () => {
          throw new TypeError("CORS");
        }),
      }),
    ).toBeUndefined();
    const never = vi.fn();
    for (const address of [
      "file:///srv/page.html",
      "https://user:pass@example.com/",
      "not a url",
    ]) {
      const result = await readPublicPageSource(address, live(), {
        fetch: never,
      });
      expect(result === undefined || result.blocked === true).toBe(true);
    }
    expect(never).not.toHaveBeenCalled();
  });

  it("rejects when the caller aborts", async () => {
    const owner = new AbortController();
    const fetch = vi.fn(async (_: string, init: RequestInit) => {
      owner.abort(new DOMException("closed", "AbortError"));
      init.signal?.throwIfAborted();
      return new Response("x");
    });
    await expect(
      readPublicPageSource("https://example.com/", owner.signal, { fetch }),
    ).rejects.toThrow("closed");
  });
});

describe("pageSourceExcerpt", () => {
  it("bounds the excerpt and reports truncation", () => {
    const result = pageSourceExcerpt("a".repeat(6000));
    expect(result).toEqual({ text: "a".repeat(5000), truncated: true });
    expect(pageSourceExcerpt(" \n\t ")).toBeUndefined();
  });
});
