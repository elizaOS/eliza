/**
 * GET/HEAD /api/avatar/discord/<file> must 400 illegal percent-encoding
 * instead of throwing URIError from decodeURIComponent. A thrown decode
 * skips the path-traversal regex and never answers the client.
 */
import { describe, expect, it, vi } from "vitest";
import { handleAvatarRoutes } from "./avatar-routes.ts";

function drive(pathname: string, method: "GET" | "HEAD" = "GET") {
  const res = {} as never;
  const error = vi.fn();
  return handleAvatarRoutes({
    req: {} as never,
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
    const { handled, error, res } = await drive("/api/avatar/discord/%", "HEAD");
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
