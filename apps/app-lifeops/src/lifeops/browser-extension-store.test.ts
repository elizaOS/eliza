import { describe, expect, it } from "vitest";
import {
  getBrowserActivitySnapshot,
  getBrowserDomainActivity,
  recordBrowserFocusWindow,
} from "./browser-extension-store.js";

function makeRuntime() {
  return {} as never;
}

describe("browser-extension-store", () => {
  it("records focus windows and aggregates matching parent domains", async () => {
    const runtime = makeRuntime();

    await recordBrowserFocusWindow(runtime, {
      deviceId: "companion-1",
      url: "https://docs.github.com/en/actions",
      windowStart: "2026-04-17T10:00:00.000Z",
      windowEnd: "2026-04-17T10:10:00.000Z",
    });
    await recordBrowserFocusWindow(runtime, {
      deviceId: "companion-1",
      url: "https://github.com/openai/openai-python",
      windowStart: "2026-04-17T10:10:00.000Z",
      windowEnd: "2026-04-17T10:15:00.000Z",
    });

    const snapshot = await getBrowserActivitySnapshot(runtime, {
      deviceId: "companion-1",
      limit: 10,
    });
    expect(snapshot.domains.map((domain) => domain.domain)).toEqual([
      "github.com",
    ]);

    const result = await getBrowserDomainActivity(runtime, {
      deviceId: "companion-1",
      domain: "github.com",
      sinceMs: Date.parse("2026-04-17T10:00:00.000Z"),
      untilMs: Date.parse("2026-04-17T10:15:00.000Z"),
    });

    expect(result.reportCount).toBe(2);
    expect(result.totalMs).toBe(15 * 60 * 1000);
  });

  it("clips focus windows to the requested interval", async () => {
    const runtime = makeRuntime();

    await recordBrowserFocusWindow(runtime, {
      deviceId: "companion-2",
      url: "https://calendar.google.com/calendar/u/0/r",
      windowStart: "2026-04-17T11:00:00.000Z",
      windowEnd: "2026-04-17T11:30:00.000Z",
    });

    const result = await getBrowserDomainActivity(runtime, {
      deviceId: "companion-2",
      domain: "calendar.google.com",
      sinceMs: Date.parse("2026-04-17T11:10:00.000Z"),
      untilMs: Date.parse("2026-04-17T11:20:00.000Z"),
    });

    expect(result.reportCount).toBe(1);
    expect(result.totalMs).toBe(10 * 60 * 1000);
  });

  it("ignores non-web URLs", async () => {
    const runtime = makeRuntime();

    expect(
      await recordBrowserFocusWindow(runtime, {
        deviceId: "companion-3",
        url: "chrome://settings",
        windowStart: "2026-04-17T12:00:00.000Z",
        windowEnd: "2026-04-17T12:05:00.000Z",
      }),
    ).toBe(false);

    const result = await getBrowserDomainActivity(runtime, {
      deviceId: "companion-3",
      domain: "settings",
      sinceMs: Date.parse("2026-04-17T12:00:00.000Z"),
      untilMs: Date.parse("2026-04-17T12:05:00.000Z"),
    });

    expect(result.reportCount).toBe(0);
    expect(result.totalMs).toBe(0);
  });
});
