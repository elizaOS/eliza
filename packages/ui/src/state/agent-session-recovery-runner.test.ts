// @vitest-environment jsdom

/**
 * Tests for the post-upgrade agent-session recovery runner (#15132).
 *
 * The runner re-runs the cloud pairing exchange to refresh a stale
 * dedicated-agent credential and navigates the current window to the `/pair`
 * relay, which pins the fresh credential and redirects to `/`, replacing the
 * password-wall dead-end with a transparent re-pair. jsdom so the no-default-
 * purge cases can assert real persisted credentials survive a mint refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudPairExchangeError } from "../components/auth/CloudPairRelay";
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
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

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

    expect(result).toEqual({ ok: true, redirectUrl, mode: "navigate" });
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

    expect(result).toEqual({ ok: true, redirectUrl, mode: "navigate" });
    expect(sleepFn).toHaveBeenCalledWith(10);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(redirectUrl);
  });

  it("can consume the /pair redirect in-process without navigating the native WebView", async () => {
    const redirectUrl = "https://agent.elizacloud.ai/pair?token=one-time";
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { redirectUrl } }));
    const navigate = vi.fn();
    const exchangePairToken = vi.fn().mockResolvedValue("agent-api-key");
    const persistPairApiToken = vi.fn();
    const onPairedInProcess = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
      consumeRedirectInProcess: true,
      exchangePairToken,
      persistPairApiToken,
      onPairedInProcess,
    });

    expect(result).toEqual({ ok: true, redirectUrl, mode: "in-process" });
    expect(navigate).not.toHaveBeenCalled();
    expect(exchangePairToken).toHaveBeenCalledWith("one-time", {
      cloudToken: "steward.jwt.token",
      agentId: "23766030-0000-0000-0000-000000000000",
      expectedOrigin: "https://agent.elizacloud.ai",
    });
    expect(persistPairApiToken).toHaveBeenCalledWith("agent-api-key");
    expect(onPairedInProcess).toHaveBeenCalledWith("agent-api-key");
  });

  it("routes a native redirect without a pair token to Cloud management", async () => {
    const redirectUrl = "https://agent.elizacloud.ai";
    const clearStalePairCredentials = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { data: { redirectUrl } }),
        ) as unknown as typeof fetch,
      navigate: vi.fn(),
      consumeRedirectInProcess: true,
      clearStalePairCredentials,
    });

    expect(result).toEqual({
      ok: false,
      reason: "manage-required",
      message: "Pairing token returned a redirect without a pair token",
    });
    expect(clearStalePairCredentials).toHaveBeenCalledOnce();
  });

  it.each([
    [
      new CloudPairExchangeError(
        "Cloud authentication required",
        401,
        "cloud_auth_required",
      ),
      "unauthorized",
      true,
    ],
    [
      new CloudPairExchangeError(
        "Invalid or expired pairing code",
        410,
        "pairing_token_invalid",
      ),
      "error",
      false,
    ],
    [
      new CloudPairExchangeError(
        "Pairing failed",
        503,
        "sandbox_credential_unavailable",
      ),
      "manage-required",
      true,
    ],
  ] as const)(
    "classifies typed native exchange failures without guessing from one status",
    async (exchangeError, expectedReason, shouldPurge) => {
      const redirectUrl = "https://agent.elizacloud.ai/pair?token=one-time";
      const clearStalePairCredentials = vi.fn();

      const result = await runAgentSessionRecovery({
        ...baseDeps,
        fetchFn: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(200, { data: { redirectUrl } }),
          ) as unknown as typeof fetch,
        navigate: vi.fn(),
        consumeRedirectInProcess: true,
        exchangePairToken: vi.fn().mockRejectedValue(exchangeError),
        clearStalePairCredentials,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(expectedReason);
      if (shouldPurge) {
        expect(clearStalePairCredentials).toHaveBeenCalledOnce();
      } else {
        expect(clearStalePairCredentials).not.toHaveBeenCalled();
      }
    },
  );

  it("does not navigate on 401 and reports Cloud reauthentication", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const navigate = vi.fn();
    const clearStalePairCredentials = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
      clearStalePairCredentials,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
    expect(navigate).not.toHaveBeenCalled();
    // The caller opted in (it independently proved the adopted pair bearer
    // stale), so the mint's refusal triggers its purge exactly once (#16666).
    expect(clearStalePairCredentials).toHaveBeenCalledTimes(1);
  });

  it("performs NO purge on 401/403 when the caller does not opt in (#16666)", async () => {
    // The mint is authorized by the Steward JWT, not the durable pair token,
    // so its refusal alone proves nothing about the pair bearer. A generic
    // pairing caller (ordinary first-run) supplies no purge and must find
    // every persisted credential intact afterwards — this is the regression
    // guard against re-introducing a default purge in the runner.
    localStorage.setItem("eliza:cloud-pair:api-token", "still-valid-bearer");
    sessionStorage.setItem("eliza:cloud-pair:api-token", "still-valid-bearer");
    localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "p1",
        profiles: [
          {
            id: "p1",
            label: "Other agent",
            kind: "cloud",
            apiBase: "https://other-agent.elizacloud.ai",
            accessToken: "other-agent-token",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    for (const [status, expectedReason] of [
      [401, "unauthorized"],
      [403, "manage-required"],
    ] as const) {
      const result = await runAgentSessionRecovery({
        ...baseDeps,
        fetchFn: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(status, { error: "refused" }),
          ) as unknown as typeof fetch,
        navigate: vi.fn(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(expectedReason);
    }

    expect(localStorage.getItem("eliza:cloud-pair:api-token")).toBe(
      "still-valid-bearer",
    );
    expect(sessionStorage.getItem("eliza:cloud-pair:api-token")).toBe(
      "still-valid-bearer",
    );
    const registry = JSON.parse(
      localStorage.getItem("elizaos:agent-profiles") ?? "{}",
    ) as { profiles: Array<{ accessToken?: string }> };
    expect(registry.profiles[0]?.accessToken).toBe("other-agent-token");
  });

  it("routes 403 to Cloud management without treating the bearer as invalid", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "forbidden" }));
    const clearStalePairCredentials = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate: vi.fn(),
      clearStalePairCredentials,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("manage-required");
    expect(clearStalePairCredentials).toHaveBeenCalledTimes(1);
  });

  it.each([
    [402, { error: "Insufficient credits" }],
    [404, { error: "Agent not found" }],
    [
      500,
      {
        error: "Agent is in an error state",
        data: { status: "error" },
      },
    ],
  ])(
    "routes permanent HTTP %i agent failures to Cloud management",
    async (status, body) => {
      const result = await runAgentSessionRecovery({
        ...baseDeps,
        fetchFn: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(status, body),
          ) as unknown as typeof fetch,
        navigate: vi.fn(),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("manage-required");
    },
  );

  it("does NOT purge pair credentials on a network-shaped failure (#16666)", async () => {
    // An offline PWA relaunch is the exact scenario the durable key exists
    // for: a fetch throw must never be treated as proof of staleness. The
    // runner folds it into reason "error" — never "unauthorized".
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const clearStalePairCredentials = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate: vi.fn(),
      clearStalePairCredentials,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
    expect(clearStalePairCredentials).not.toHaveBeenCalled();
  });

  it("does NOT purge pair credentials on a 5xx mint failure (#16666)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const clearStalePairCredentials = vi.fn();

    const result = await runAgentSessionRecovery({
      ...baseDeps,
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate: vi.fn(),
      clearStalePairCredentials,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
    expect(clearStalePairCredentials).not.toHaveBeenCalled();
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
