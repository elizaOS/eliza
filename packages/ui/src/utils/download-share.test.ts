/** Verifies attachment naming, download fallbacks, cancellation, and platform sharing with mocked browser bridges. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canShareFiles,
  downloadAttachment,
  extForMime,
  filenameForMime,
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
  vi.useRealTimers();
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

  it("falls back after a stalled fetch reaches the prefetch deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }),
    );

    const download = withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/stalled.png", "stalled.png"),
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(clickSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await download;

    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(anchor.href).toBe("https://example.com/stalled.png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while the response body is being read", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const blob = vi.fn(
      () =>
        new Promise<Blob>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return { ok: true, blob } as unknown as Response;
      }),
    );

    const download = withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/stream.png", "stream.png"),
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(clickSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await download;

    expect(blob).toHaveBeenCalledTimes(1);
    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(anchor.href).toBe("https://example.com/stream.png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation without clicking the fallback anchor", async () => {
    const caller = new AbortController();
    const reason = new DOMException("View closed", "AbortError");
    const removeAbortListener = vi.spyOn(caller.signal, "removeEventListener");
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }),
    );

    const download = withGlobal("Capacitor", undefined, () =>
      downloadAttachment(
        "https://example.com/cancelled.png",
        "cancelled.png",
        caller.signal,
      ),
    );
    caller.abort(reason);

    await expect(download).rejects.toBe(reason);
    expect(requestSignal?.reason).toBe(reason);
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("falls back when a prefetch aborts before the picker opens", async () => {
    const picker = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The request was aborted", "AbortError");
      }),
    );
    vi.stubGlobal("window", { showSaveFilePicker: picker });

    await withGlobal("Capacitor", undefined, () =>
      downloadAttachment("https://example.com/cat.png", "cat.png"),
    );

    expect(picker).not.toHaveBeenCalled();
    expect(anchor.href).toBe("https://example.com/cat.png");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("does not start an anchor download when the user cancels the picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["hello"]))),
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
