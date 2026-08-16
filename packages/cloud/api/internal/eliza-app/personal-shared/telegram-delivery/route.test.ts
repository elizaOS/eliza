/** Exercises fail-closed service authentication on the canonical Telegram ledger route. */

import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@/types/cloud-worker-env";
import app, { createPersonalTelegramDeliveryRoute } from "./route";

function request(authorization?: string): Request {
  return new Request("https://api.eliza.app/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      project: "eliza-app",
      accountFingerprint: "a".repeat(64),
      senderId: "123456",
      messageId: "81001",
      operation: "read",
    }),
  });
}

describe("Personal Telegram delivery route authentication", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await app.fetch(request(), {} as AppEnv["Bindings"]);
    expect(response.status).toBe(401);
  });

  test("rejects a generic internal shared-secret identity", async () => {
    const response = await app.fetch(request("Bearer local-secret"), {
      INTERNAL_SECRET: "local-secret",
    } as unknown as AppEnv["Bindings"]);
    expect(response.status).toBe(403);
  });

  test("allows only the gateway service to reach the named durable ledger", async () => {
    let objectName = "";
    const traceIds: string[] = [];
    const gatewayApp = createPersonalTelegramDeliveryRoute(async () => ({
      podName: "gateway-1",
      service: "webhook-gateway",
    }));
    const authorized = request("Bearer gateway-jwt");
    authorized.headers.set(
      "X-Eliza-Trace-Id",
      "11111111-1111-4111-8111-111111111111",
    );
    const response = await gatewayApp.fetch(authorized, {
      PERSONAL_TELEGRAM_DELIVERIES: {
        getByName(name: string) {
          objectName = name;
          return {
            async fetch(_input: RequestInfo | URL, init?: RequestInit) {
              const traceId = new Headers(init?.headers).get(
                "X-Eliza-Trace-Id",
              );
              if (traceId) traceIds.push(traceId);
              return Response.json({ state: null });
            },
          };
        },
      },
    } as unknown as AppEnv["Bindings"]);

    expect(response.status).toBe(200);
    expect(objectName).toMatch(
      /^telegram:eliza-app:[a-f0-9]{64}:[a-f0-9]{64}$/,
    );
    expect(traceIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
