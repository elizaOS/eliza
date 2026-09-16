/** Exercises late Cloud rejection through the actual client and session store with held browser/native HTTP fixtures. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import { verifyDirectCloudStewardSession } from "./client-cloud";

const transport = vi.hoisted(() => ({ native: false, request: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => transport.native },
  CapacitorHttp: {
    request: (...args: unknown[]) => transport.request(...args),
  },
}));

describe.each([false, true])(
  "Cloud rejection ownership, native=%s",
  (native) => {
    let client: ElizaClient;
    beforeEach(async () => {
      transport.native = native;
      transport.request.mockReset();
      setBootConfig({ branding: {}, cloudApiBase: "https://api.eliza.app" });
      client = new ElizaClient();
      client.setBaseUrl("https://api.eliza.app");
      await writeStoredStewardToken("original-fixture-session");
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      transport.native = false;
      setBootConfig({ branding: {} });
    });

    it.each([
      ["status", "current"],
      ["status", "replacement"],
      ["status", "logout-login"],
      ["status", "target"],
      ["status", "late-canonical"],
      ["status-forbidden", "current"],
      ["status-forbidden", "replacement"],
      ["status-forbidden", "logout-login"],
      ["status-forbidden", "target"],
      ["credits-forbidden", "current"],
      ["credits-forbidden", "replacement"],
      ["credits-forbidden", "logout-login"],
      ["credits-forbidden", "target"],
      ["verify-user", "current"],
      ["verify-user", "replacement"],
      ["verify-user", "logout-login"],
      ["verify-user", "target"],
      ["verify-user", "late-canonical"],
      ["verify-credits", "current"],
      ["verify-credits", "replacement"],
      ["verify-credits", "logout-login"],
      ["verify-credits", "target"],
      ["verify-credits", "late-canonical"],
    ])(
      "%s rejection after %s only affects its original session",
      async (operation, change) => {
        let release!: () => void;
        let entered!: () => void;
        const dispatched = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const response = async (url: string) => {
          if (operation === "verify-credits" && url.endsWith("/api/v1/user"))
            return { status: 200, data: { id: "fixture-user" } };
          entered();
          await held;
          return {
            status:
              operation === "verify-credits" || operation.endsWith("forbidden")
                ? 403
                : 401,
            data: {},
          };
        };
        transport.request.mockImplementation(({ url }: { url: string }) =>
          response(url),
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const result = await response(String(input));
            return new Response(JSON.stringify(result.data), {
              status: result.status,
            });
          }),
        );
        if (change === "late-canonical") {
          await clearStoredStewardToken();
          client.setToken("original-fixture-session");
        }
        const pending = operation.startsWith("status")
          ? client.getCloudStatus()
          : operation === "credits-forbidden"
            ? client.getCloudCredits()
            : verifyDirectCloudStewardSession({
                cloudApiBase: "https://api.eliza.app",
                stewardToken: "original-fixture-session",
              });
        // Observe failures immediately: a superseded request must not masquerade
        // as the newly selected account's definitive authentication rejection.
        const result = pending.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        try {
          await dispatched;
          if (change === "late-canonical")
            await writeStoredStewardToken("original-fixture-session");
          else if (change === "replacement")
            await writeStoredStewardToken("replacement-fixture-session");
          else if (change === "logout-login") {
            await clearStoredStewardToken();
            await writeStoredStewardToken("original-fixture-session");
          } else if (change === "target") {
            setBootConfig({
              branding: {},
              cloudApiBase: "https://staging-api.eliza.app",
            });
            client.setBaseUrl("https://staging-api.eliza.app");
          }
          release();
          const settled = await result;
          if (change === "current") {
            expect(settled.error).toBeUndefined();
            expect(settled.value).toMatchObject(
              operation.startsWith("status")
                ? { reason: "auth-rejected" }
                : operation === "credits-forbidden"
                  ? { authRejected: true }
                  : { status: { reason: "auth-rejected" } },
            );
            expect(readStoredStewardToken()).toBe(
              operation.endsWith("forbidden")
                ? "original-fixture-session"
                : null,
            );
          } else {
            expect(settled.error).toMatchObject({
              code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
            });
            expect(readStoredStewardToken()).toBe(
              change === "replacement"
                ? "replacement-fixture-session"
                : "original-fixture-session",
            );
          }
        } finally {
          release();
          await result;
        }
      },
    );
  },
);
