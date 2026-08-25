/**
 * Unit tests for `/api/avatar/discord/*` route contracts:
 * path validation, illegal percent-encoding bounds, content-type mapping,
 * immutable caching headers, HEAD vs GET streaming, and 404/400 failure modes.
 */
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/plugin-discord", () => ({
  getDiscordAvatarCacheDir: () => "/mock/avatar/cache",
  getDiscordAvatarCachePath: (fileName: string) =>
    path.join("/mock/avatar/cache", fileName),
}));

import { handleAvatarRoutes } from "./avatar-routes.ts";

function createMockResponse(): http.ServerResponse & {
  body: unknown;
  headers: Record<string, string | number>;
  statusCode: number;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: undefined as unknown,
    writeHead: vi.fn(
      (status: number, headers: Record<string, string | number>) => {
        res.statusCode = status;
        res.headers = { ...headers };
        return res;
      },
    ),
    end: vi.fn((chunk?: unknown) => {
      res.body = chunk;
      return res;
    }),
  };
  return res as unknown as http.ServerResponse & {
    body: unknown;
    headers: Record<string, string | number>;
    statusCode: number;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

function drive(pathname: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const res = createMockResponse();
  const error = vi.fn();
  return handleAvatarRoutes({
    req: {} as http.IncomingMessage,
    res,
    method,
    pathname,
    json: vi.fn(),
    error,
  }).then((handled) => ({ handled, error, res }));
}

describe("handleAvatarRoutes percent-encoding", () => {
  it.each([
    ["bare percent", "/api/avatar/discord/%"],
    ["truncated hex", "/api/avatar/discord/%E0%A4%A"],
    ["illegal hex", "/api/avatar/discord/%ZZ.png"],
    ["truncated after slash", "/api/avatar/discord/foo%"],
  ])("400s %s without throwing", async (_label, pathname) => {
    const { handled, error, res } = await drive(pathname);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Invalid Discord avatar path", 400);
  });

  it("400s the same illegal encodings on HEAD", async () => {
    const { handled, error, res } = await drive(
      "/api/avatar/discord/%",
      "HEAD",
    );
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Invalid Discord avatar path", 400);
  });

  it("400s a decoded name that fails the cache filename regex", async () => {
    const { handled, error, res } = await drive(
      "/api/avatar/discord/..%2Fsecret.png",
    );
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Invalid Discord avatar path", 400);
  });
});

describe("handleAvatarRoutes route matching and methods", () => {
  it("returns false for non-matching paths", async () => {
    const { handled, error } = await drive("/api/avatar/vrm");
    expect(handled).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false for unsupported methods on avatar path", async () => {
    const { handled, error } = await drive(
      "/api/avatar/discord/user123.png",
      "POST",
    );
    expect(handled).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("handleAvatarRoutes file delivery", () => {
  it.each([
    ["avatar.png", "image/png"],
    ["avatar.jpg", "image/jpeg"],
    ["avatar.jpeg", "image/jpeg"],
    ["avatar.gif", "image/gif"],
    ["avatar.webp", "image/webp"],
  ])(
    "serves %s with MIME type %s and immutable cache headers",
    async (fileName, expectedMime) => {
      const fakeBytes = Buffer.from(`data-for-${fileName}`);
      vi.spyOn(fs, "statSync").mockReturnValue({
        isFile: () => true,
        size: fakeBytes.length,
      } as fs.Stats);
      vi.spyOn(fs, "readFileSync").mockReturnValue(fakeBytes);

      const { handled, error, res } = await drive(
        `/api/avatar/discord/${fileName}`,
        "GET",
      );

      expect(handled).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": fakeBytes.length,
        "Content-Type": expectedMime,
      });
      expect(res.end).toHaveBeenCalledWith(fakeBytes);
    },
  );

  it("handles HEAD request by sending headers without body bytes", async () => {
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: 512,
    } as fs.Stats);
    const readSpy = vi.spyOn(fs, "readFileSync");

    const { handled, error, res } = await drive(
      "/api/avatar/discord/avatar.png",
      "HEAD",
    );

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": 512,
      "Content-Type": "image/png",
    });
    expect(res.end).toHaveBeenCalledWith();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when avatar file does not exist on disk", async () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { handled, error, res } = await drive(
      "/api/avatar/discord/nonexistent.png",
      "GET",
    );

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Discord avatar not found", 404);
  });

  it("returns 404 when avatar cache entry is a directory rather than a file", async () => {
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => false,
      size: 0,
    } as fs.Stats);

    const { handled, error, res } = await drive(
      "/api/avatar/discord/directory-entry.png",
      "GET",
    );

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Discord avatar not found", 404);
  });
});
