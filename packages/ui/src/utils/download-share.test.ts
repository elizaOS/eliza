/** Verifies extForMime through the package's configured test harness. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canShareFiles,
  DOWNLOAD_SHARE_FETCH_TIMEOUT_MS,
  downloadAttachment,
  extForMime,
  filenameForMime,
  getDownloadShareResponseWithFetch,
  shareAttachment,
} from "./download-share";

/* ── Global shape helpers ─────────────────────────────────────────────── */

const g = globalThis as Record<string, unknown>;

function withGlobal<T>(key: string, value: unknown, fn: () => T): T {
  const had = key in g;
  const prev = g[key];
  if (value === undefined) {
    delete g[key];
  } else {
    g[key] = value;
  }
  try {
    return fn();
  } finally {
    if (had) g[key] = prev;
    else delete g[key];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── filenameForMime / extForMime ─────────────────────────────────────── */

describe("extForMime", () => {
  it("maps known mime types to extensions", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("video/mp4")).toBe("mp4");
    expect(extForMime("audio/mpeg")).toBe("mp3");
    expect(extForMime("application/pdf")).toBe("pdf");
  });

  it("ignores charset parameters and casing", () => {
    expect(extForMime("text/plain; charset=utf-8")).toBe("txt");
    expect(extForMime("IMAGE/PNG")).toBe("png");
  });

  it("falls back to bin for unknown / empty types", () => {
    expect(extForMime("application/x-unknown")).toBe("bin");
    expect(extForMime("")).toBe("bin");
  });
});

describe("filenameForMime", () => {
  it("returns download.<ext> when no base is given", () => {
    expect(filenameForMime("image/png")).toBe("download.png");
    expect(filenameForMime("application/x-unknown")).toBe("download.bin");
  });

  it("appends the mime extension to a base without one", () => {
    expect(filenameForMime("image/jpeg", "vacation")).toBe("vacation.jpg");
  });

  it("trusts a base that already carries an extension", () => {
    expect(filenameForMime("image/png", "photo.webp")).toBe("photo.webp");
    expect(filenameForMime("application/pdf", "report.pdf")).toBe("report.pdf");
  });
});

/* ── canShareFiles ────────────────────────────────────────────────────── */

describe("canShareFiles", () => {
  it("is false with no navigator.share and no Capacitor", () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    expect(withGlobal("Capacitor", undefined, () => canShareFiles())).toBe(
      false,
    );
  });

  it("is true when navigator.share exists", () => {
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
    expect(withGlobal("Capacitor", undefined, () => canShareFiles())).toBe(
      true,
    );
  });

  it("is true when navigator.canShare exists", () => {
    vi.stubGlobal("navigator", { canShare: () => true });
    expect(withGlobal("Capacitor", undefined, () => canShareFiles())).toBe(
      true,
    );
  });

  it("is true when the Capacitor Share plugin is present", () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    const cap = { Plugins: { Share: { share: () => Promise.resolve() } } };
    expect(withGlobal("Capacitor", cap, () => canShareFiles())).toBe(true);
  });

  it("ignores a Capacitor global without a usable Share plugin", () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    const cap = { Plugins: {} };
    expect(withGlobal("Capacitor", cap, () => canShareFiles())).toBe(false);
  });
});

/* ── downloadAttachment (anchor fallback) ─────────────────────────────── */

describe("downloadAttachment — <a download> fallback path", () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let removeSpy: ReturnType<typeof vi.fn>;
  let anchor: HTMLAnchorElement;

  beforeEach(() => {
    clickSpy = vi.fn();
    removeSpy = vi.fn();
    // Build a fake anchor that records what the helper assigns to it.
    anchor = {
      href: "",
      download: "",
      rel: "",
      style: {} as CSSStyleDeclaration,
      click: clickSpy,
      remove: removeSpy,
    } as unknown as HTMLAnchorElement;

    const realCreateElement = document.createElement.bind(document);
    // Cast to the overloaded `createElement` signature — the electrobun
    // `webview` overload (→ WebviewTag) makes a bare `(tag: string)` impl fail
    // typecheck (pre-existing develop red, unrelated to this suite's behavior).
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "a") return anchor;
      return realCreateElement(tag);
    }) as typeof document.createElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(
      (node) => node as Node,
    );

    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock-object-url"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    // No save-file-picker, no Capacitor → force the anchor path.
    vi.stubGlobal("window", {
      /* no showSaveFilePicker */
    });
  });

  it("fetches the url, creates an object URL, and clicks an <a download>", async () => {
    const blob = new Blob(["hello"], { type: "image/png" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => blob,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/cat.png", "cat.png"),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/cat.png",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      (URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> })
        .createObjectURL,
    ).toHaveBeenCalledWith(blob);
    expect(anchor.download).toBe("cat.png");
    expect(anchor.href).toBe("blob:mock-object-url");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(
      (URL as unknown as { revokeObjectURL: ReturnType<typeof vi.fn> })
        .revokeObjectURL,
    ).toHaveBeenCalledWith("blob:mock-object-url");
  });

  it("links the raw url directly when fetch fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchMock);

    await withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/cat.png", "cat.png"),
    );

    expect(anchor.href).toBe("https://example.com/cat.png");
    expect(anchor.download).toBe("cat.png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw url when the picker prefetch times out", async () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetchMock = vi.fn(async () => {
      throw timeout;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      showSaveFilePicker: vi.fn(),
    });

    await withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/cat.png", "cat.png"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anchor.href).toBe("https://example.com/cat.png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("does not start an anchor download when the user cancels the picker", async () => {
    const blob = new Blob(["hello"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(blob)),
    );
    vi.stubGlobal("window", {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException("The user aborted a request", "AbortError");
      }),
    });

    await withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/cat.png", "cat.png"),
    );

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

/* ── shareAttachment ──────────────────────────────────────────────────── */

describe("shareAttachment", () => {
  it("returns false when no share path exists", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    const result = await withGlobal("Capacitor", undefined, () =>
      shareAttachment("https://example.com/a.png", { title: "A" }),
    );
    expect(result).toBe(false);
  });

  it("uses navigator.share on the web and returns true", async () => {
    const shareMock = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share: shareMock });
    const result = await withGlobal("Capacitor", undefined, () =>
      shareAttachment("https://example.com/a.png", { title: "A" }),
    );
    expect(shareMock).toHaveBeenCalledWith({
      url: "https://example.com/a.png",
      title: "A",
    });
    expect(result).toBe(true);
  });

  it("swallows user cancellation (AbortError) and returns false", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const shareMock = vi.fn(async () => {
      throw abort;
    });
    vi.stubGlobal("navigator", { share: shareMock });
    const result = await withGlobal("Capacitor", undefined, () =>
      shareAttachment("https://example.com/a.png"),
    );
    expect(result).toBe(false);
  });

  it("prefers the Capacitor Share plugin when present", async () => {
    const capShare = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { userAgent: "test" });
    const cap = { Plugins: { Share: { share: capShare } } };
    const result = await withGlobal("Capacitor", cap, () =>
      shareAttachment("https://example.com/a.png", { title: "A" }),
    );
    expect(capShare).toHaveBeenCalledWith({
      url: "https://example.com/a.png",
      title: "A",
    });
    expect(result).toBe(true);
  });
});

/* ── Blob prefetch deadline ─────────────────────────────────────────── */

const PREFETCH_URL = "https://example.com/cat.png";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected download-share abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("download-share blob prefetch deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(DOWNLOAD_SHARE_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled prefetch GET at the injected deadline", async () => {
    await expect(
      getDownloadShareResponseWithFetch(PREFETCH_URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline active while the response body is read", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected download-share abort signal");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    };

    const response = await getDownloadShareResponseWithFetch(
      PREFETCH_URL,
      fetchImpl,
      10,
    );
    await expect(response.blob()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("surfaces a provider error from a completed prefetch GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getDownloadShareResponseWithFetch(PREFETCH_URL, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful prefetch GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("hello", { status: 200 });
    };

    const response = await getDownloadShareResponseWithFetch(
      PREFETCH_URL,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("hello");
  });
});
