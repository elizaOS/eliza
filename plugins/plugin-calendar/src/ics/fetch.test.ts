/**
 * ICS transport tests drive the real shared redirect/SSRF guard with an
 * injected wire so no test bypasses the policy layer it claims to cover.
 */

import { describe, expect, it, vi } from "vitest";
import {
  fetchIcsFeed,
  fingerprintIcsSourceUrl,
  MAX_ICS_FEED_BYTES,
  normalizeIcsSourceUrl,
} from "./fetch.js";

const VALID_CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

describe("ICS subscription fetch", () => {
  it("normalizes webcal and fingerprints the full capability URL", () => {
    const parsed = normalizeIcsSourceUrl(
      "webcal://calendar.example.test/family.ics?token=secret#ignored",
    );

    expect(parsed.href).toBe(
      "https://calendar.example.test/family.ics?token=secret",
    );
    expect(fingerprintIcsSourceUrl(parsed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects embedded username and password credentials", () => {
    expect(() =>
      normalizeIcsSourceUrl(
        "https://school-user:school-pass@calendar.example.test/feed.ics",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ICS_SOURCE_USERINFO_FORBIDDEN",
      }),
    );
  });

  it("sends conditional validators and handles a 304 without a body", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("if-none-match")).toBe('"rev-4"');
        expect(headers.get("if-modified-since")).toBe(
          "Wed, 20 May 2026 10:00:00 GMT",
        );
        return new Response(null, {
          status: 304,
          headers: { etag: '"rev-4"' },
        });
      },
    );

    await expect(
      fetchIcsFeed({
        sourceUrl: "https://calendar.example.test/family.ics?token=secret",
        validators: {
          etag: '"rev-4"',
          lastModified: "Wed, 20 May 2026 10:00:00 GMT",
        },
        transport: { fetchImpl },
      }),
    ).resolves.toEqual({
      state: "not_modified",
      finalOrigin: "https://calendar.example.test",
      etag: '"rev-4"',
      lastModified: "Wed, 20 May 2026 10:00:00 GMT",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns bounded UTF-8 text while exposing only the final origin", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(VALID_CALENDAR, {
        status: 200,
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          etag: '"rev-5"',
          "last-modified": "Thu, 21 May 2026 10:00:00 GMT",
        },
      });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl:
          "https://calendar.example.test/private/feed.ics?token=secret",
        transport: { fetchImpl },
      }),
    ).resolves.toEqual({
      state: "fetched",
      finalOrigin: "https://calendar.example.test",
      etag: '"rev-5"',
      lastModified: "Thu, 21 May 2026 10:00:00 GMT",
      body: VALID_CALENDAR,
      byteLength: new TextEncoder().encode(VALID_CALENDAR).byteLength,
    });
  });

  it("blocks a literal metadata endpoint before the transport runs", async () => {
    const fetchImpl = vi.fn(async () => new Response(VALID_CALENDAR));

    await expect(
      fetchIcsFeed({
        sourceUrl: "http://169.254.169.254/latest/meta-data/calendar.ics",
        transport: { fetchImpl },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates a redirect and blocks a private target", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://127.0.0.1/private-calendar.ics",
        },
      });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl: "https://calendar.example.test/redirect.ics",
        transport: { fetchImpl },
      }),
    ).rejects.toThrow(/blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails a declared oversized feed without reading it", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(VALID_CALENDAR, {
        status: 200,
        headers: {
          "content-length": String(MAX_ICS_FEED_BYTES + 1),
        },
      });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl: "https://calendar.example.test/oversized.ics",
        transport: { fetchImpl },
      }),
    ).rejects.toMatchObject({
      code: "ICS_FEED_TOO_LARGE",
    });
  });

  it("cancels an oversized streamed feed with the size classification intact", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ICS_FEED_BYTES + 1));
      },
    });
    const fetchImpl = vi.fn(async () => {
      return new Response(stream, { status: 200 });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl: "https://calendar.example.test/streamed-oversized.ics",
        transport: { fetchImpl },
      }),
    ).rejects.toMatchObject({
      code: "ICS_FEED_TOO_LARGE",
    });
  });

  it("fails invalid UTF-8 instead of replacing source bytes", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new Uint8Array([0xc3, 0x28]), { status: 200 });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl: "https://calendar.example.test/invalid-utf8.ics",
        transport: { fetchImpl },
      }),
    ).rejects.toMatchObject({
      code: "ICS_FEED_INVALID_UTF8",
    });
  });

  it("classifies provider HTTP failure without exposing the source path", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("unavailable", { status: 503 });
    });

    await expect(
      fetchIcsFeed({
        sourceUrl:
          "https://calendar.example.test/private/feed.ics?token=do-not-leak",
        transport: { fetchImpl },
      }),
    ).rejects.toMatchObject({
      code: "ICS_FEED_HTTP_ERROR",
      message: "Calendar feed returned HTTP 503.",
      context: {
        finalOrigin: "https://calendar.example.test",
        status: 503,
      },
      severity: "ephemeral",
    });
  });
});
