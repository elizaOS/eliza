import { describe, expect, it } from "vitest";
import { failureResponse } from "./cloud-worker-errors";

function fakeContext() {
  return {
    json(body: unknown, status: number) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as import("hono").Context;
}

async function bodyOf(res: Response): Promise<{ error: string; code: string }> {
  return (await res.json()) as { error: string; code: string };
}

describe("failureResponse infrastructure-error sanitization", () => {
  it("never leaks raw SQL from a Drizzle/postgres query failure", async () => {
    const error = new Error(
      'Failed query: select "id","name","key_hash","permissions" from "api_keys" where "api_keys"."key_hash" = $1\nparams: 2ebf70e43edbaadbc5e7c8ebcf6dd9c61f8b986fc3dd5ac1d1474ed515e239ac',
    );
    const res = failureResponse(fakeContext(), error);
    expect(res.status).toBe(500);
    const body = await bodyOf(res);
    expect(body.error).toBe("An unexpected error occurred");
    expect(body.code).toBe("internal_error");
    expect(body.error).not.toContain("api_keys");
    expect(body.error).not.toContain("permissions");
  });

  it("forces 500 for postgres SQLSTATE-coded errors", async () => {
    const error = Object.assign(new Error('column "key" does not exist'), {
      code: "42703",
    });
    const res = failureResponse(fakeContext(), error);
    expect(res.status).toBe(500);
    const body = await bodyOf(res);
    expect(body.error).toBe("An unexpected error occurred");
  });

  it("still surfaces genuine 4xx domain messages", async () => {
    const error = Object.assign(new Error("Invalid API key"), {
      name: "AuthenticationError",
    });
    const res = failureResponse(fakeContext(), error);
    expect(res.status).toBe(401);
    const body = await bodyOf(res);
    expect(body.error).toBe("Invalid API key");
    expect(body.code).toBe("authentication_required");
  });
});
