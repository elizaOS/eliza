/**
 * Serves the built app SPA (packages/app/dist) with a minimal mock agent API so
 * the renderer boots to the shell without a live backend. The view-audit
 * crawlers hit this server to screenshot every view; mocked endpoints return
 * empty/skeleton data, which is sufficient for layout and spacing review.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "bun";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.APP_DIST_ROOT?.trim() || path.join(repoRoot, "packages/app/dist");

// Minimal mock of the agent API so the renderer boots past "connecting" and
// renders the shell + sections (empty/skeleton data is fine for spacing review).
const J = (o) =>
  new Response(JSON.stringify(o), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
function mockApi(path) {
  if (path === "/api/status")
    return J({
      state: "running",
      agentName: "Eliza",
      model: "local",
      canRespond: true,
      startedAt: 0,
      uptime: 1,
      startup: { phase: "running", attempt: 0 },
      cloud: {
        connectionStatus: "disconnected",
        cloudProvisioned: false,
        hasApiKey: false,
      },
    });
  if (path === "/api/auth/status")
    return J({ required: false, pairingEnabled: false });
  if (path.startsWith("/api/views")) return J({ views: [] });
  if (path.startsWith("/api/plugins")) return J({ plugins: [] });
  if (path.startsWith("/api/settings") || path.startsWith("/api/secrets"))
    return J({ entries: [], settings: {} });
  return J({ ok: true, data: null, items: [], entries: [] });
}

serve({
  port: 8899,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) return mockApi(u.pathname);
    let p = ROOT + decodeURIComponent(u.pathname);
    if (u.pathname === "/" || !existsSync(p) || !u.pathname.includes("."))
      p = ROOT + "/index.html";
    const f = Bun.file(p);
    if (await f.exists()) return new Response(f);
    return new Response(Bun.file(ROOT + "/index.html"));
  },
});
console.log("serving " + ROOT + " (+mock /api) on :8899");
