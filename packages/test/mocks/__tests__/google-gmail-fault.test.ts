import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

let activeMocks: StartedMocks | null = null;

afterEach(async () => {
  if (!activeMocks) return;
  await activeMocks.stop();
  activeMocks = null;
});

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function errorBody(body: Record<string, unknown>): Record<string, unknown> {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("expected Google-style error body");
  }
  return error as Record<string, unknown>;
}

describe("Google Gmail mock fault injection", () => {
  it.each([
    ["server_error", 500, "INTERNAL"],
    ["auth_expired", 401, "UNAUTHENTICATED"],
    ["rate_limit", 429, "RESOURCE_EXHAUSTED"],
  ] as const)("returns a typed %s failure for configured Gmail list requests", async (mode, expectedStatus, expectedGoogleStatus) => {
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const configured = await jsonRequest(
      `${baseUrl}/__mock/google/gmail/fault`,
      {
        method: "POST",
        body: JSON.stringify({
          mode,
          method: "GET",
          path: "/gmail/v1/users/me/messages",
        }),
      },
    );
    expect(configured.response.status).toBe(200);

    const failed = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`);
    expect(failed.response.status).toBe(expectedStatus);
    expect(errorBody(failed.body)).toEqual(
      expect.objectContaining({
        code: expectedStatus,
        status: expectedGoogleStatus,
      }),
    );

    const cleared = await jsonRequest(`${baseUrl}/__mock/google/gmail/fault`, {
      method: "DELETE",
    });
    expect(cleared.response.status).toBe(200);

    const healthy = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`);
    expect(healthy.response.status).toBe(200);
    expect(Array.isArray(healthy.body.messages)).toBe(true);
  });

  it("honors the Mockoon-compatible Gmail fault header", async () => {
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const failed = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`, {
      headers: { "X-Mockoon-Fault": "auth_expired" },
    });

    expect(failed.response.status).toBe(401);
    expect(errorBody(failed.body)).toEqual(
      expect.objectContaining({
        code: 401,
        status: "UNAUTHENTICATED",
      }),
    );
  });

  it("honors configured fault limits", async () => {
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const configured = await jsonRequest(
      `${baseUrl}/__mock/google/gmail/fault`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "server_error",
          method: "GET",
          path: "gmail/v1/users/me/messages",
          remaining: 1,
        }),
      },
    );
    expect(configured.response.status).toBe(200);
    expect(configured.body.fault).toEqual(
      expect.objectContaining({
        path: "/gmail/v1/users/me/messages",
        remaining: 1,
      }),
    );

    const failed = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`);
    expect(failed.response.status).toBe(500);

    const healthy = await jsonRequest(`${baseUrl}/gmail/v1/users/me/messages`);
    expect(healthy.response.status).toBe(200);
    expect(Array.isArray(healthy.body.messages)).toBe(true);
  });

  it("returns 207 and records partial successes for batchModify partial_failure", async () => {
    activeMocks = await startMocks({ envs: ["google"] });
    const baseUrl = activeMocks.baseUrls.google;

    const configured = await jsonRequest(
      `${baseUrl}/__mock/google/gmail/fault`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: "partial_failure",
          method: "POST",
          path: "/gmail/v1/users/me/messages/batchModify",
        }),
      },
    );
    expect(configured.response.status).toBe(200);

    const modified = await jsonRequest(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: ["msg-finance", "msg-sarah", "msg-newsletter"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );

    expect(modified.response.status).toBe(207);
    expect(modified.body).toEqual(
      expect.objectContaining({
        partialFailure: true,
        requestedIds: ["msg-finance", "msg-sarah", "msg-newsletter"],
        succeededIds: ["msg-finance", "msg-sarah"],
        failedIds: ["msg-newsletter"],
      }),
    );
  });
});
