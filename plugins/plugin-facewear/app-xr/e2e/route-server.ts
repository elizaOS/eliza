/**
 * Real-route e2e server (replaces the deleted view-server.mjs mock).
 *
 * Serves the ACTUAL `viewHostRoute.routeHandler` output from
 * `plugin-facewear/src/routes/view-host.ts` — the same HTML, CSP and
 * postMessage bridge the agent ships — instead of a hand-rolled stub. The view
 * catalog (`/api/xr/views`) returns a fixed id list so the CRUD spec can iterate
 * without booting a full runtime (the per-view-host HTML is the real thing).
 *
 * Run with bun (the route is a .ts module): `bun e2e/route-server.ts`.
 */
import { createServer } from "node:http";
import { viewHostRoute } from "../../src/routes/view-host.ts";

const PORT = Number(process.env.XR_TEST_PORT ?? 31337);

// A representative catalog of registered xr views (real ids from facewear/app
// plugins). The point of the test is the REAL view-host route output per id, not
// runtime view discovery (which needs a live agent).
const VIEW_IDS = [
  "facewear",
  "smartglasses",
  "wallet",
  "messages",
  "training",
  "phone",
];

type RouteResult = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/xr/views") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        views: VIEW_IDS.map((id) => ({ id, viewType: "xr" })),
      }),
    );
    return;
  }

  const match = url.pathname.match(/^\/api\/xr\/view-host\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    // Drive the REAL route handler — no re-implemented markup.
    const result = (await viewHostRoute.routeHandler?.({
      params: { id },
      runtime: { port: PORT },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test ctx for a pure handler
    } as any)) as RouteResult;
    res.writeHead(result?.status ?? 200, result?.headers ?? {});
    res.end(
      typeof result?.body === "string"
        ? result.body
        : JSON.stringify(result?.body ?? {}),
    );
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>xr route e2e</title><body>ok</body>");
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  process.stdout.write(
    `[route-server] real view-host route on http://localhost:${PORT}\n`,
  );
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close(() => process.exit(0)));
