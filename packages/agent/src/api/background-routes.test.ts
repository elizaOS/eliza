/**
 * Integration tests for `POST /api/background/upload-image`, the wallpaper
 * re-host route: a valid image data URL lands in the content-addressed media
 * store and returns a served `/api/media/<sha256>` URL, identical images
 * de-dupe to one file, and non-image / oversized / undecodable payloads are
 * rejected. Also verifies the wallpaper is pinned so the orphan GC never
 * collects it despite having no message referent. Runs against a real temp
 * state dir and the real media store — no mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RouteHandlerContext } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "background-routes-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Imported after env is set so the media store resolves to the temp dir.
const { backgroundUploadImageRoute } = await import("./background-routes.ts");
const { gcUnreferencedMedia, readBackgroundPins } = await import(
  "./media-store.ts"
);

// A 1x1 transparent PNG.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function callUpload(body: unknown) {
  // The route only reads ctx.body; the runtime is untouched on this path.
  return backgroundUploadImageRoute.routeHandler?.({
    body,
  } as unknown as RouteHandlerContext) as Promise<{
    status: number;
    body: { url?: string; error?: string };
  }>;
}

describe("POST /api/background/upload-image (wallpaper re-host, quota fix)", () => {
  it("persists an image data URL to the media store and returns a served URL", async () => {
    const res = await callUpload({ dataUrl: TINY_PNG_DATA_URL });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/api\/media\/[0-9a-f]{64}\.png$/);
    // The bytes really landed in the content-addressed store.
    const fileName = res.body.url?.split("/").pop() ?? "";
    expect(fs.existsSync(path.join(stateDir, "media", fileName))).toBe(true);
  });

  it("is content-addressed: the same image re-hosts to the same URL", async () => {
    const a = await callUpload({ dataUrl: TINY_PNG_DATA_URL });
    const b = await callUpload({ dataUrl: TINY_PNG_DATA_URL });
    expect(a.body.url).toBe(b.body.url);
  });

  it("rejects a non-image payload", async () => {
    const res = await callUpload({
      dataUrl: "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=",
    });
    expect(res.status).toBe(400);
    expect(res.body.url).toBeUndefined();
  });

  it("rejects a missing/non-string payload", async () => {
    expect((await callUpload({})).status).toBe(400);
    expect((await callUpload({ dataUrl: 42 })).status).toBe(400);
  });

  it("rejects an oversized data URL", async () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(9 * 1024 * 1024)}`;
    const res = await callUpload({ dataUrl: huge });
    expect(res.status).toBe(413);
  });

  it("rejects an undecodable data URL", async () => {
    const res = await callUpload({ dataUrl: "data:image/png;base64," });
    expect(res.status).toBe(400);
  });

  it("pins the wallpaper so the orphan GC never collects it (client-side-only referent)", async () => {
    const res = await callUpload({ dataUrl: TINY_PNG_DATA_URL });
    const fileName = res.body.url?.split("/").pop() ?? "";
    expect(readBackgroundPins()).toContain(fileName);

    // Age the file past the GC grace window, then sweep with an EMPTY
    // reference set (no message references the wallpaper — that's the bug
    // this pin exists to fix). The pinned file must survive.
    const filePath = path.join(stateDir, "media", fileName);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
    gcUnreferencedMedia(new Set());
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
