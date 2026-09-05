/** Exercises the HTTP-to-consent authority boundary using real delegated grants. */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  OutreachrDelegationError,
  OutreachrDelegationService,
  type OutreachrGrant,
} from "@/lib/services/outreachr-delegation";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createGoogleConnectHandler } from "./google-connect";

async function fixture() {
  const secret = "google-connect-fixture-client-secret-123456789";
  const registration = {
    appId: randomUUID(),
    origin: "https://outreachr.example.com",
    clientSecretSha256: createHash("sha256").update(secret).digest("hex"),
  };
  const user = {
    id: randomUUID(),
    organizationId: randomUUID(),
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  };
  const grants = new Map<string, OutreachrGrant>();
  let now = Date.now();
  let codeUnused = true;
  const delegation = new OutreachrDelegationService({
    async verifyRegistration() {},
    async consumeCode(code) {
      if (code !== "eac_fixture" || !codeUnused) return null;
      codeUnused = false;
      return { appId: registration.appId, userId: user.id };
    },
    async findPrincipal() {
      return user;
    },
    async saveGrant(key, grant) {
      grants.set(key, grant);
      return true;
    },
    async readGrant(key) {
      return grants.get(key) ?? null;
    },
    async deleteGrant(key) {
      return grants.delete(key);
    },
    now: () => now,
  });
  const grant = await delegation.exchange(registration, secret, "eac_fixture");
  type Connect = Parameters<typeof createGoogleConnectHandler>[0]["connect"];
  const started: Parameters<Connect>[0][] = [];
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?state=provider-state";
  const connect: Connect = async (args) => {
    started.push(args);
    return {
      provider: "google",
      side: args.side,
      mode: "cloud_managed",
      requestedCapabilities: args.capabilities ?? [],
      redirectUri: args.redirectUrl ?? "/auth/success",
      authUrl,
    };
  };
  const app = new Hono<AppEnv>();
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof OutreachrDelegationError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500,
    ),
  );
  app.post(
    "/google/connect",
    createGoogleConnectHandler({ delegation, connect }),
  );
  const env = {
    OUTREACHR_APP_ID: registration.appId,
    OUTREACHR_ORIGIN: registration.origin,
    OUTREACHR_CLIENT_SECRET_SHA256: registration.clientSecretSha256,
  };
  const request = (body = "{}", client = secret, token = grant.token) =>
    app.request(
      "/google/connect",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Outreachr-Client": client,
          Authorization: `Bearer ${token}`,
        },
      },
      env,
    );
  return {
    request,
    started,
    user,
    authUrl,
    expire: () => {
      now += 8 * 86_400_000;
    },
    revoke: () => delegation.revoke(registration, secret, grant.token),
  };
}

describe("Outreachr managed Google consent", () => {
  test("binds a valid request to the verified owner and first-party completion page", async () => {
    const f = await fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    const body = z
      .object({ success: z.boolean(), authUrl: z.string() })
      .strict()
      .parse(await response.json());
    expect(body).toEqual({
      success: true,
      authUrl: f.authUrl,
    });
    expect(f.started).toEqual([
      {
        userId: f.user.id,
        organizationId: f.user.organizationId,
        side: "owner",
        redirectUrl: "/auth/success?platform=google",
        capabilities: [
          "google.basic_identity",
          "google.gmail.triage",
          "google.gmail.send",
          "google.calendar.read",
          "google.calendar.write",
        ],
      },
    ]);
  });
  test("rejects forged identity, redirect, side, and capability overrides before OAuth", async () => {
    const f = await fixture();
    for (const input of [
      { userId: randomUUID() },
      { organizationId: randomUUID() },
      { side: "agent" },
      { redirectUrl: "https://attacker.example/" },
      { capabilities: ["google.gmail.manage"] },
    ])
      expect((await f.request(JSON.stringify(input))).status).toBe(400);
    expect((await f.request("{")).status).toBe(400);
    expect(f.started).toHaveLength(0);
  });
  test("wrong clients and tokens cannot initiate consent", async () => {
    const f = await fixture();
    expect((await f.request("{}", "wrong-client")).status).toBe(401);
    expect((await f.request("{}", undefined, "outreachr_forged")).status).toBe(
      401,
    );
    expect(f.started).toHaveLength(0);
  });
  test("expired and revoked grants cannot initiate consent", async () => {
    const expired = await fixture();
    expired.expire();
    expect((await expired.request()).status).toBe(401);
    expect(expired.started).toHaveLength(0);
    const revoked = await fixture();
    await revoked.revoke();
    expect((await revoked.request()).status).toBe(401);
    expect(revoked.started).toHaveLength(0);
  });
});
