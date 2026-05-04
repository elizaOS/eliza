// Minimal local-agent stub: proves the bun-on-Android architecture end-to-end
// without dragging in PGlite extensions, plugin resolution, or the agent's
// child_process-heavy connectors. RuntimeGate's "Local Agent" probe only
// needs /api/health to respond — anything richer comes from the real agent
// bundle once it's wired in.
//
// Invoked by scripts/spike-android-agent/bootstrap.sh on a connected device,
// or by MiladyAgentService.java in a future iteration.

const port = Number(process.env.PORT || process.env.MILADY_API_PORT || 31337);
const startedAt = Date.now();

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/api/health") {
      return Response.json({
        ok: true,
        agent: "milady-spike",
        bun: Bun.version,
        uptime: (Date.now() - startedAt) / 1000,
      });
    }
    if (u.pathname === "/api/agent/status") {
      return Response.json({ status: "running", mode: "local-stub" });
    }
    return new Response("milady local-agent stub", { status: 200 });
  },
});

console.log(
  `[milady-agent-stub] listening on 127.0.0.1:${port} (bun ${Bun.version})`,
);
