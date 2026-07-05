/**
 * #14040 sub-defect 2: the cloud dedicated-agent-proxy answers `GET /api/status`
 * with `202 { data: { status:"starting", jobId, retryAfterMs } }` while a
 * dedicated agent warms. Previously `getStatus()` sent that through the
 * `rawRequest` resume-retry loop, which (after exhausting its budget) threw
 * `agent_resuming` — swallowed by the readiness poll's catch, so the launcher
 * showed a spinner with no progress signal. `getStatus()` must instead surface
 * the FIRST 202 body as an explicit progress `AgentStatus` (state:"starting" +
 * resumeProgress) WITHOUT blocking on the retry loop.
 *
 * Transport stubbed, no live agent, no desktop RPC (plain HTTP status path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";
import type { AgentRequestTransport } from "./transport";

function makeClient(handler: AgentRequestTransport["request"]): ElizaClient {
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request: vi.fn(handler) });
  return client;
}

describe("ElizaClient.getStatus cloud resume progress (#14040 sub-defect 2)", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.restoreAllMocks();
    // No desktop electrobun RPC / native lifecycle — force the plain HTTP path.
    Reflect.deleteProperty(globalThis, "window");
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("surfaces a 202 resume body as an honest progress AgentStatus (no throw, no retry wait)", async () => {
    let calls = 0;
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        calls += 1;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              agentId: "agent-1",
              status: "starting",
              jobId: "resume-job-42",
              alreadyInProgress: false,
              retryAfterMs: 5000,
            },
          }),
          {
            status: 202,
            headers: { "content-type": "application/json", "Retry-After": "5" },
          },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const status = await client.getStatus();

    // Explicit progress state — NOT undefined/unreachable, NOT a thrown error.
    expect(status.state).toBe("starting");
    // A transient cloud wake is not an authoritative no-provider signal.
    expect(status.canRespond).toBeUndefined();
    expect(status.resumeProgress).toMatchObject({
      status: "starting",
      jobId: "resume-job-42",
      retryAfterMs: 5000,
      alreadyInProgress: false,
    });
    // Each observation is stamped so a single long-running resume still
    // advances the launcher's progress signal on every probe (#14040 sub-3).
    expect(typeof status.resumeProgress?.observedAt).toBe("number");
    // Crucially: it returned on the FIRST 202 — the resume-retry loop (which
    // would have re-issued the request up to 6 more times, ~30s of waiting)
    // was skipped for the status poll.
    expect(calls).toBe(1);
  });

  it("returns a normal running status verbatim when the agent is up (200)", async () => {
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        return new Response(
          JSON.stringify({
            state: "running",
            agentName: "Eliza",
            model: "gpt-4",
            canRespond: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    await expect(client.getStatus()).resolves.toEqual({
      state: "running",
      agentName: "Eliza",
      model: "gpt-4",
      canRespond: true,
    });
  });

  it("tolerates a 202 with no parseable resume body (defaults to a starting progress state)", async () => {
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        return new Response("not json", { status: 202 });
      }
      return new Response("{}", { status: 200 });
    });

    const status = await client.getStatus();
    expect(status.state).toBe("starting");
    expect(status.resumeProgress).toMatchObject({ status: "starting" });
    expect(typeof status.resumeProgress?.observedAt).toBe("number");
  });

  it("throws on a malformed 200 status body instead of masking it as an empty not-ready status", async () => {
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        // 200 OK but non-JSON — a broken/proxy-corrupted status endpoint.
        return new Response("<html>gateway error</html>", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    // Must surface as an error (matching the pre-fix `this.fetch` contract),
    // NOT a silent empty status that leaves the launcher polling forever.
    await expect(client.getStatus()).rejects.toThrow();
  });

  it("throws on a non-202 status error (500) instead of masking it as not-ready", async () => {
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    // A broken status endpoint must surface as an error (the readiness poll's
    // catch keeps polling), NOT a silent not-ready spinner — preserving the
    // pre-fix `this.fetch("/api/status")` throw for non-202 failures.
    await expect(client.getStatus()).rejects.toThrow();
  });

  it("stamps a distinct observedAt on successive 202 polls (progress advances even for a stable job)", async () => {
    const client = makeClient(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/status") {
        // SAME status + jobId every poll — a single long-running resume.
        return new Response(
          JSON.stringify({
            success: true,
            data: { status: "starting", jobId: "stable-job" },
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const a = await client.getStatus();
    // Ensure the clock advances between observations.
    await new Promise((r) => setTimeout(r, 2));
    const b = await client.getStatus();

    expect(a.resumeProgress?.jobId).toBe("stable-job");
    expect(b.resumeProgress?.jobId).toBe("stable-job");
    // Same job, but each observation is stamped distinctly → the launcher's
    // progress token advances, resetting the slow-boot window (#14040 sub-3).
    expect(b.resumeProgress?.observedAt).toBeGreaterThanOrEqual(
      a.resumeProgress?.observedAt ?? 0,
    );
  });
});
