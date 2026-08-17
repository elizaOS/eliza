/**
 * POST /api/organizations/credentials untrusted JSON body contract.
 *
 * Hono 4.13 `c.req.json()` is a bare `JSON.parse`. The handler catch maps
 * SyntaxError through `failureResponse` to HTTP 500 instead of a caller 400.
 * The team credential pool must not live-probe or store a key on garbage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "00000000-0000-4000-8000-0000000000dd";
const ORG_ID = "00000000-0000-4000-8000-0000000000ee";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
}));
type ContributeInput = {
  organizationId: string;
  userId: string;
  provider: string;
  apiKey: string;
};

const contributePooledCredential = mock(
  async (
    _input: ContributeInput,
  ): Promise<{ id: string; provider: string; last4: string }> => {
    throw new Error("contributePooledCredential must not run");
  },
);
const listPooledCredentials = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/team-credential-pool/service", () => ({
  contributePooledCredential,
  listPooledCredentials,
  TeamCredentialPoolError: class TeamCredentialPoolError extends Error {
    status = 400;
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {}, STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: mock(
    (c: { json: (body: unknown, status: number) => unknown }) =>
      c.json({ success: false, error: "An unexpected error occurred" }, 500),
  ),
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

describe("POST /api/organizations/credentials JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    contributePooledCredential.mockClear();
    contributePooledCredential.mockImplementation(async (_input) => {
      throw new Error("contributePooledCredential must not run");
    });
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed credential body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as { success: boolean; error: string }).toEqual(
        {
          success: false,
          error: "Invalid JSON body",
        },
      );
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalled();
      expect(contributePooledCredential).not.toHaveBeenCalled();
    },
  );

  test.each(['["sk-test"]', '"sk-test"', "null", "12"])(
    "rejects non-object credential body %s with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as { success: boolean; error: string }).toEqual(
        {
          success: false,
          error: "Invalid JSON body",
        },
      );
      expect(contributePooledCredential).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing fields via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
    expect(contributePooledCredential).not.toHaveBeenCalled();
  });

  test("still contributes a canonical object body", async () => {
    contributePooledCredential.mockResolvedValue({
      id: "cred-1",
      provider: "openai",
      last4: "1234",
    });

    const res = await post(
      JSON.stringify({ provider: "openai", apiKey: "sk-test-key" }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { id: "cred-1", provider: "openai" },
    });
    expect(contributePooledCredential).toHaveBeenCalledTimes(1);
    expect(contributePooledCredential.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      provider: "openai",
      apiKey: "sk-test-key",
    });
  });
});
