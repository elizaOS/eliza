/**
 * Tests for the post-upgrade agent-session recovery runner (#15132).
 *
 * The runner re-runs the cloud pairing exchange to refresh a stale
 * dedicated-agent credential and navigates the current window to the `/pair`
 * relay, which pins the fresh credential and redirects to `/`, replacing the
 * password-wall dead-end with a transparent re-pair.
 */
import { describe, expect, it, vi } from "vitest";
import { runAgentSessionRecovery } from "./agent-session-recovery-runner";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const baseDeps = {
  cloudApiBase: "https://elizacloud.ai",
  agentId: "23766030-0000-0000-0000-000000000000",
  cloudToken: "steward.jwt.token",
};

describe("runAgentSessionRecovery", () => {
  it("navigates the current window to the /pair redirect and reports success", async () => {
    const redirectUrl =
      "https://agent-23766030.elizacloud.ai/pair?token=one-time";
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { redirectUrl } }));
    const navigate = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    });

    expect(result).toEqual({ ok: true, redirectUrl });
    expect(navigate).toHaveBeenCalledWith(redirectUrl);
    // Authorization header carries the cloud session token.
    const [, init] = fetchFn.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: "Bearer steward.jwt.token" });
    // Targets the cloud pairing-token endpoint for the dedicated agent.
    expect(fetchFn.mock.calls[0][0]).toContain(
      "/api/v1/eliza/agents/23766030-0000-0000-0000-000000000000/pairing-token",
    );
  });

  it("polls through 202 (agent warming) then navigates once ready", async () => {
    const redirectUrl = "https://agent.elizacloud.ai/pair?token=X";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { data: { retryAfterMs: 10 } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { redirectUrl } }));
    const navigate = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
      sleepFn,
    });

    expect(result).toEqual({ ok: true, redirectUrl });
    expect(sleepFn).toHaveBeenCalledWith(10);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(redirectUrl);
  });

  it("does NOT navigate on 401, the cloud session is invalid, wall stands", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const navigate = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not loop forever: gives up with not-ready after the deadline", async () => {
    let now = 1_000;
    const nowFn = () => now;
    const fetchFn = vi.fn().mockImplementation(async () => {
      // Every poll returns 202 (still warming); advance the clock past the cap.
      now += 60_000;
      return jsonResponse(202, { data: { retryAfterMs: 1 } });
    });
    const navigate = vi.fn();
    const sleepFn = vi.fn().mockResolvedValue(undefined);

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
      sleepFn,
      nowFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-ready");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does NOT navigate to an unsafe (non-http) redirect URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: { redirectUrl: "javascript:alert(1)" },
      }),
    );
    const navigate = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reports error (no navigate) when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const navigate = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.message).toContain("network down");
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});
