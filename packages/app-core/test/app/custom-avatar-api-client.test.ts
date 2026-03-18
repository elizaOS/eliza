/**
 * Unit tests for custom avatar (VRM) and custom background API client methods.
 *
 * Creates a ElizaClient with an explicit base URL and mocks globalThis.fetch
 * to verify HTTP calls without a real server.
 */

import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fetchMock: ReturnType<typeof vi.fn>;
let client: ElizaClient;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn();
  Object.defineProperty(globalThis, "fetch", {
    value: fetchMock,
    writable: true,
    configurable: true,
  });
  client = new ElizaClient("http://localhost:9999");
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: originalFetch,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Custom VRM upload
// ---------------------------------------------------------------------------

describe("uploadCustomVrm", () => {
  it("sends POST with binary body and correct content-type", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, size: 12 }),
    });

    const glbData = new Uint8Array([
      0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 2, 12, 0, 0, 0,
    ]);
    const file = new File([glbData], "custom.vrm", {
      type: "model/gltf-binary",
    });

    await client.uploadCustomVrm(file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/avatar/vrm");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect((init.body as ArrayBuffer).byteLength).toBe(12);
  });

  it("throws on server error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid VRM file" }),
    });

    const file = new File([new Uint8Array(4)], "bad.vrm");
    await expect(client.uploadCustomVrm(file)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hasCustomVrm
// ---------------------------------------------------------------------------

describe("hasCustomVrm", () => {
  it("returns true when server responds 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Length": "12" }),
    });

    const result = await client.hasCustomVrm();
    expect(result).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/avatar/vrm");
    expect(init.method).toBe("HEAD");
  });

  it("returns false when server responds 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await client.hasCustomVrm();
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    fetchMock.mockRejectedValue(new Error("Network failure"));

    const result = await client.hasCustomVrm();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Custom background upload
// ---------------------------------------------------------------------------

describe("uploadCustomBackground", () => {
  it("sends POST with binary body and correct content-type", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, size: 64 }),
    });

    const pngData = new Uint8Array(64);
    pngData.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([pngData], "bg.png", { type: "image/png" });

    await client.uploadCustomBackground(file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/avatar/background");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect((init.body as ArrayBuffer).byteLength).toBe(64);
  });

  it("sends JPEG file correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, size: 32 }),
    });

    const jpegData = new Uint8Array(32);
    jpegData.set([0xff, 0xd8, 0xff, 0xe0]);
    const file = new File([jpegData], "bg.jpg", { type: "image/jpeg" });

    await client.uploadCustomBackground(file);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/avatar/background");
    expect(init.method).toBe("POST");
    expect((init.body as ArrayBuffer).byteLength).toBe(32);
  });

  it("throws on server error (e.g., invalid image)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid image file" }),
    });

    const file = new File([new Uint8Array(4)], "bad.txt");
    await expect(client.uploadCustomBackground(file)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hasCustomBackground
// ---------------------------------------------------------------------------

describe("hasCustomBackground", () => {
  it("returns true when server responds 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Length": "100" }),
    });

    const result = await client.hasCustomBackground();
    expect(result).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/avatar/background");
    expect(init.method).toBe("HEAD");
  });

  it("returns false when server responds 404", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await client.hasCustomBackground();
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    fetchMock.mockRejectedValue(new Error("Network failure"));

    const result = await client.hasCustomBackground();
    expect(result).toBe(false);
  });
});
