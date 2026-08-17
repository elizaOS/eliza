/**
 * Exercises canonical Worker error responses without external infrastructure.
 */
import { describe, expect, it } from "vitest";
import { failureResponse } from "./cloud-worker-errors";

function fakeContext() {
  return {
    json(body: unknown, status: number, headers?: Record<string, string>) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    },
  } as unknown as import("hono").Context;
}

async function bodyOf(res: Response): Promise<{
  success: false;
  error: string;
  code: string;
}> {
  return (await res.json()) as { success: false; error: string; code: string };
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

  it("maps a nested cutover pause constraint to a sanitized retryable 503", async () => {
    const databaseCause = Object.assign(new Error("raw lifecycle trigger detail"), {
      code: "23503",
      constraint: "auto_top_up_cutover_paused",
    });
    const error = new Error("Failed query: delete from organizations", {
      cause: databaseCause,
    });

    const res = failureResponse(fakeContext(), error);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await bodyOf(res)).toEqual({
      success: false,
      error: "Service temporarily unavailable",
      code: "service_unavailable",
    });
  });

  it.each(["auto_top_up_unresolved_work", "organization_nonzero_credit_balance"])(
    "maps the exact %s constraint to a sanitized lifecycle conflict",
    async (constraint) => {
      const error = Object.assign(new Error("private database lifecycle detail"), {
        code: constraint === "organization_nonzero_credit_balance" ? "23514" : "23503",
        constraint,
      });

      const res = failureResponse(fakeContext(), error);
      expect(res.status).toBe(409);
      expect(await bodyOf(res)).toEqual({
        success: false,
        error: "Organization cannot be removed while billing work or credit remains",
        code: "billing_state_conflict",
      });
    },
  );

  it("does not classify an unrelated foreign-key violation", async () => {
    const error = Object.assign(new Error("private foreign-key detail"), {
      code: "23503",
      constraint: "users_organization_id_organizations_id_fk",
    });

    const res = failureResponse(fakeContext(), error);
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({
      success: false,
      error: "An unexpected error occurred",
      code: "internal_error",
    });
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
