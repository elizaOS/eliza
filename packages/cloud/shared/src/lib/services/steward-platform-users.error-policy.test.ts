/** Exercises Steward platform user failure boundaries with deterministic service fixtures. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteStewardPlatformUser,
  isStewardPlatformConfigured,
  provisionStewardPlatformUser,
} from "./steward-platform-users";

const originalFetch = globalThis.fetch;
const originalStewardApiUrl = process.env.STEWARD_API_URL;
const originalStewardPlatformKeys = process.env.STEWARD_PLATFORM_KEYS;

function restoreEnv(): void {
  if (originalStewardApiUrl === undefined) delete process.env.STEWARD_API_URL;
  else process.env.STEWARD_API_URL = originalStewardApiUrl;

  if (originalStewardPlatformKeys === undefined) delete process.env.STEWARD_PLATFORM_KEYS;
  else process.env.STEWARD_PLATFORM_KEYS = originalStewardPlatformKeys;
}

describe("steward platform users error policy", () => {
  beforeEach(() => {
    restoreEnv();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreEnv();
    globalThis.fetch = originalFetch;
  });

  it("returns unavailable when the platform key is not configured", () => {
    delete process.env.STEWARD_PLATFORM_KEYS;

    expect(isStewardPlatformConfigured()).toBe(false);
  });

  it("preserves malformed Steward JSON responses as the thrown cause", async () => {
    process.env.STEWARD_API_URL = "https://steward.example";
    process.env.STEWARD_PLATFORM_KEYS = "platform-key";
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      } as Response;
    }) as typeof fetch;

    await expect(
      provisionStewardPlatformUser({
        email: "USER@Example.COM",
        emailVerified: true,
        name: "User",
      }),
    ).rejects.toMatchObject({
      message: "Steward /platform/users returned 200 and its JSON body could not be parsed",
      cause: expect.objectContaining({ message: "Unexpected token <" }),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://steward.example/platform/users",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Steward-Platform-Key": "platform-key",
        }),
      }),
    );
  });

  it("deletes the exact personal tenant before deleting the Steward identity", async () => {
    process.env.STEWARD_API_URL = "https://steward.example";
    process.env.STEWARD_PLATFORM_KEYS = "platform-key";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ) as typeof fetch;

    await expect(deleteStewardPlatformUser("user-123")).resolves.toEqual({
      userId: "user-123",
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://steward.example/platform/tenants/personal-user-123",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://steward.example/platform/users/user-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("fails closed without deleting the identity when personal tenant cleanup is blocked", async () => {
    process.env.STEWARD_API_URL = "https://steward.example";
    process.env.STEWARD_PLATFORM_KEYS = "platform-key";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "Tenant has retained provider state" }), {
          status: 409,
        }),
    ) as typeof fetch;

    await expect(deleteStewardPlatformUser("user-456")).rejects.toThrow(
      "Tenant has retained provider state",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("treats already-removed tenant and identity as an idempotent purge", async () => {
    process.env.STEWARD_API_URL = "https://steward.example";
    process.env.STEWARD_PLATFORM_KEYS = "platform-key";
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 })) as typeof fetch;

    await expect(deleteStewardPlatformUser("user-789")).resolves.toEqual({
      userId: "user-789",
    });
  });
});
