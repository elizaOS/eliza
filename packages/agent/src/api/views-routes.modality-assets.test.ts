/**
 * Exact-modality read-route tests prove an unavailable TUI/XR declaration can
 * never fall back to a same-id GUI view's metadata or executable assets.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinViews } from "./views-registry.ts";
import { handleViewsRoutes, type ViewsRouteContext } from "./views-routes.ts";

function readContext(subResource: string): {
  ctx: ViewsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const suffix = subResource ? `/${subResource}` : "";
  const pathname = `/api/views/settings${suffix}`;
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.headers = {};
  const end = vi.fn();
  const res = {
    end,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
  } as unknown as http.ServerResponse;
  const error = vi.fn();
  const json = vi.fn();
  return {
    ctx: {
      req,
      res,
      method: "GET",
      pathname,
      url: new URL(`http://local${pathname}?viewType=tui`),
      error,
      json,
      broadcastWs: vi.fn(),
    },
    error,
    json,
    end,
  };
}

describe("view read routes preserve exact requested modality", () => {
  beforeEach(() => registerBuiltinViews());
  afterEach(() => vi.restoreAllMocks());

  it.each(["", "bundle.js", "frame.html", "chunk.js", "hero"])(
    "does not serve the GUI declaration for TUI request /%s",
    async (subResource) => {
      const request = readContext(subResource);

      await expect(handleViewsRoutes(request.ctx)).resolves.toBe(true);

      expect(request.error).toHaveBeenCalledWith(
        request.ctx.res,
        'View "settings" not found',
        404,
      );
      expect(request.json).not.toHaveBeenCalled();
      expect(request.end).not.toHaveBeenCalled();
    },
  );
});
