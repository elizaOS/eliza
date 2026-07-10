/**
 * Protocol-level tests for the GitHub device-flow state machine. GitHub is
 * stubbed at the module's HTTP boundary (the injectable `fetch`, answering
 * with real `Response` objects) and time is injected, so every GitHub protocol
 * answer — pending, slow_down, denied, expired, token — and the local
 * rate-limit/expiry bookkeeping is driven for real without contacting
 * github.com. The full route/dispatcher path is covered separately in
 * `../device-login-e2e.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearDeviceFlowsForTest,
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "./github-device-flow.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface RecordedRequest {
  url: string;
  form: URLSearchParams;
}

/**
 * A scripted GitHub double: each element of `tokenResponses` answers one
 * access-token poll in order. Requests are recorded (URL + decoded form body)
 * so tests can assert exactly what left the module.
 */
function makeGitHub(options: {
  deviceCodeBody?: Record<string, unknown>;
  deviceCodeStatus?: number;
  tokenResponses?: Array<
    { body: Record<string, unknown>; status?: number } | Error
  >;
}) {
  const requests: RecordedRequest[] = [];
  let tokenCall = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    requests.push({ url, form: new URLSearchParams(String(init?.body)) });
    if (url === DEVICE_CODE_URL) {
      return new Response(
        JSON.stringify(
          options.deviceCodeBody ?? {
            device_code: "dc_secret",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          },
        ),
        {
          status: options.deviceCodeStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url === ACCESS_TOKEN_URL) {
      const scripted = options.tokenResponses?.[tokenCall];
      tokenCall += 1;
      if (!scripted) throw new Error(`unscripted token poll #${tokenCall}`);
      if (scripted instanceof Error) throw scripted;
      return new Response(JSON.stringify(scripted.body), {
        status: scripted.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    tokenPolls: () => requests.filter((r) => r.url === ACCESS_TOKEN_URL).length,
  };
}

/** Mutable injected clock. */
function makeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

afterEach(() => {
  clearDeviceFlowsForTest();
});

describe("startDeviceFlow", () => {
  it("registers a flow and returns only user-facing fields", async () => {
    const github = makeGitHub({});
    const clock = makeClock();
    const started = await startDeviceFlow("client-123", {
      fetchImpl: github.fetchImpl,
      now: clock.now,
    });
    expect(started.userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toBe("https://github.com/login/device");
    expect(started.intervalSeconds).toBe(5);
    expect(started.expiresInSeconds).toBe(900);
    // The opaque local handle must never be GitHub's device_code.
    expect(started.flowId).not.toBe("dc_secret");
    expect(JSON.stringify(started)).not.toContain("dc_secret");
    // The request GitHub saw carried the client id and scope.
    expect(github.requests[0]?.form.get("client_id")).toBe("client-123");
    expect(github.requests[0]?.form.get("scope")).toBe("repo read:user");
  });

  it("maps a GitHub 5xx to a 502 upstream error", async () => {
    const github = makeGitHub({
      deviceCodeStatus: 503,
      deviceCodeBody: { error: "boom" },
    });
    await expect(
      startDeviceFlow("client-123", { fetchImpl: github.fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_error", httpStatus: 502 });
  });

  it("maps a 200-with-error body to a 502 upstream error", async () => {
    const github = makeGitHub({
      deviceCodeBody: { error: "unauthorized_client" },
    });
    await expect(
      startDeviceFlow("client-123", { fetchImpl: github.fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_error", httpStatus: 502 });
  });

  it("rejects a device-code response missing required fields", async () => {
    const github = makeGitHub({ deviceCodeBody: { user_code: "X" } });
    await expect(
      startDeviceFlow("client-123", { fetchImpl: github.fetchImpl }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("treats an unreachable GitHub as a 502 with the cause attached", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const err = await startDeviceFlow("client-123", { fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).httpStatus).toBe(502);
    expect(((err as DeviceFlowError).cause as Error).message).toBe(
      "ECONNREFUSED",
    );
  });
});

describe("pollDeviceFlow", () => {
  it("rejects an unknown flow id with 404", async () => {
    const github = makeGitHub({});
    await expect(
      pollDeviceFlow("no-such-flow", { fetchImpl: github.fetchImpl }),
    ).rejects.toMatchObject({ code: "unknown_flow", httpStatus: 404 });
  });

  it("returns pending on authorization_pending and rate-limits the next poll locally", async () => {
    const github = makeGitHub({
      tokenResponses: [{ body: { error: "authorization_pending" } }],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    const first = await pollDeviceFlow(flowId, io);
    expect(first).toEqual({ status: "pending", retryAfterSeconds: 5 });
    expect(github.tokenPolls()).toBe(1);

    // Within the interval the module answers locally — GitHub is not hit.
    clock.advance(1_000);
    const second = await pollDeviceFlow(flowId, io);
    expect(second).toEqual({ status: "pending", retryAfterSeconds: 4 });
    expect(github.tokenPolls()).toBe(1);
  });

  it("backs off by 5s on slow_down, per GitHub's protocol", async () => {
    const github = makeGitHub({
      tokenResponses: [{ body: { error: "slow_down" } }],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    const result = await pollDeviceFlow(flowId, io);
    expect(result).toEqual({ status: "pending", retryAfterSeconds: 10 });

    // The grown interval governs the local gate too.
    clock.advance(6_000);
    const gated = await pollDeviceFlow(flowId, io);
    expect(gated).toEqual({ status: "pending", retryAfterSeconds: 4 });
    expect(github.tokenPolls()).toBe(1);
  });

  it("completes exactly once and consumes the flow", async () => {
    const github = makeGitHub({
      tokenResponses: [
        {
          body: {
            access_token: "gho_token",
            token_type: "bearer",
            scope: "repo,read:user",
          },
        },
      ],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    const result = await pollDeviceFlow(flowId, io);
    expect(result).toEqual({
      status: "complete",
      token: "gho_token",
      tokenType: "bearer",
      scope: "repo,read:user",
    });
    // The token request GitHub saw used the device_code grant.
    const tokenReq = github.requests.find((r) => r.url === ACCESS_TOKEN_URL);
    expect(tokenReq?.form.get("device_code")).toBe("dc_secret");
    expect(tokenReq?.form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "unknown_flow",
    });
  });

  it("ends the flow with 403 when the user declines on github.com", async () => {
    const github = makeGitHub({
      tokenResponses: [{ body: { error: "access_denied" } }],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "authorization_declined",
      httpStatus: 403,
    });
    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "unknown_flow",
    });
  });

  it("ends the flow with 410 when GitHub reports the code expired", async () => {
    const github = makeGitHub({
      tokenResponses: [{ body: { error: "expired_token" } }],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "flow_expired",
      httpStatus: 410,
    });
  });

  it("keeps the flow alive across a transient upstream failure", async () => {
    const github = makeGitHub({
      tokenResponses: [
        new Error("ECONNRESET"),
        {
          body: { access_token: "gho_after_retry", token_type: "bearer" },
        },
      ],
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "upstream_error",
      httpStatus: 502,
    });
    clock.advance(5_000);
    const result = await pollDeviceFlow(flowId, io);
    expect(result).toMatchObject({
      status: "complete",
      token: "gho_after_retry",
    });
  });

  it("drops a flow whose device code passed its expiry", async () => {
    const github = makeGitHub({
      deviceCodeBody: {
        device_code: "dc_secret",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 10,
      },
    });
    const clock = makeClock();
    const io = { fetchImpl: github.fetchImpl, now: clock.now };
    const { flowId } = await startDeviceFlow("client-123", io);

    clock.advance(11_000);
    await expect(pollDeviceFlow(flowId, io)).rejects.toMatchObject({
      code: "unknown_flow",
      httpStatus: 404,
    });
  });
});
