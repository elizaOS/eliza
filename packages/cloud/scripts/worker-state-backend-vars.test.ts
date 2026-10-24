import { describe, expect, test } from "bun:test";
import {
  fetchStateBackendVars,
  planStateBackendVars,
  StateBackendInventoryError,
} from "./worker-state-backend-vars.mjs";

const redis = {
  CLOUD_AUTH_STATE_BACKEND: "redis",
  CLOUD_HF_EGRESS_BACKEND: "redis",
  CLOUD_VOICE_USAGE_BACKEND: "redis",
  CLOUD_RATE_STATE_BACKEND: "redis",
  CLOUD_A2A_STATE_BACKEND: "redis",
};
const authority = {
  ...redis,
  DEPLOY_ENVIRONMENT: "production",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "token-value",
};

function respond(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

async function failure(env: Record<string, string>, fetchImpl: typeof fetch) {
  try {
    await fetchStateBackendVars(env, fetchImpl);
  } catch (error) {
    expect(error).toBeInstanceOf(StateBackendInventoryError);
    return (error as Error).message;
  }
  throw new Error("expected a failure");
}

describe("planStateBackendVars", () => {
  test("retains an existing redis selector and always pins cloudflare", () => {
    expect(
      planStateBackendVars(
        [{ name: "CLOUD_AUTH_STATE_BACKEND", type: "plain_text" }],
        { ...redis, CLOUD_A2A_STATE_BACKEND: "cloudflare" },
      ),
    ).toEqual([
      "CLOUD_AUTH_STATE_BACKEND:redis",
      "CLOUD_A2A_STATE_BACKEND:cloudflare",
    ]);
  });

  test("names the offending binding without reading values", () => {
    expect(() =>
      planStateBackendVars(
        [
          { name: "CACHE_KV", type: "kv_namespace" },
          { name: "CACHE_KV", type: "secret_text" },
        ],
        redis,
      ),
    ).toThrow("duplicate binding CACHE_KV");
    expect(() =>
      planStateBackendVars([{ name: "bad-name", type: "kv_namespace" }], redis),
    ).toThrow("malformed name at index 0 (type kv_namespace)");
    expect(() =>
      planStateBackendVars([], { ...redis, CLOUD_RATE_STATE_BACKEND: "" }),
    ).toThrow("Invalid state backend");
  });
});

describe("fetchStateBackendVars", () => {
  test("reports the HTTP status and numeric Cloudflare codes only", async () => {
    const message = await failure(
      authority,
      respond(403, {
        success: false,
        errors: [
          { code: 10000, message: `secret ${authority.CLOUDFLARE_API_TOKEN}` },
        ],
      }),
    );
    expect(message).toBe(
      "Binding inventory unavailable (HTTP 403; cloudflare codes 10000)",
    );
    expect(message).not.toContain("token-value");
  });

  test("reports a rejected payload and an invalid inventory category", async () => {
    expect(
      await failure(
        authority,
        respond(200, { success: false, errors: [{ code: 7003 }] }),
      ),
    ).toBe("Binding inventory rejected (cloudflare codes 7003)");
    expect(
      await failure(
        authority,
        respond(200, {
          success: true,
          result: { bindings: [{ name: "A" }, { name: "A" }] },
        }),
      ),
    ).toBe("Invalid binding inventory: duplicate binding A");
    expect(
      await failure(
        { ...authority, CLOUDFLARE_API_TOKEN: "" },
        respond(200, {}),
      ),
    ).toBe("Missing deployment authority");
  });

  test("returns the planned selectors on success", async () => {
    expect(
      await fetchStateBackendVars(
        authority,
        respond(200, {
          success: true,
          result: { bindings: [{ name: "CLOUD_RATE_STATE_BACKEND" }] },
        }),
      ),
    ).toEqual(["CLOUD_RATE_STATE_BACKEND:redis"]);
  });
});
