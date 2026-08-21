/** Completion-route tests enforce authenticated host claim fencing. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const complete = mock();
const authenticate = mock();

mock.module("@/db/repositories/remote-command-envelopes", () => ({
  remoteCommandEnvelopesRepository: {
    complete,
    readOwnedResult: mock(),
  },
}));
mock.module("../../../../host-auth", () => ({
  authenticateRemoteHost: authenticate,
}));

const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.route(
  "/api/v1/remote/sessions/:id/commands/:commandId",
  route,
);

const resultEnvelope = {
  version: 1,
  algorithm: "ECDH-P256-HKDF-SHA256+A256GCM",
  senderKeyId: "host-key",
  recipientKeyId: "phone-key",
  ephemeralPublicKeyJwk: {
    kty: "EC",
    crv: "P-256",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  },
  salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("remote command completion route", () => {
  beforeEach(() => {
    complete.mockReset();
    authenticate.mockReset();
    authenticate.mockResolvedValue({ id: "host-1" });
  });

  test("requires the claim attempt fence", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/remote/sessions/session-1/commands/command-1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resultEnvelope }),
        },
      ),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  test("passes the authenticated host and exact claim attempt", async () => {
    complete.mockResolvedValue({ status: "completed" });
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/remote/sessions/session-1/commands/command-1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimAttempt: 3, resultEnvelope }),
        },
      ),
      {} as AppEnv["Bindings"],
    );
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith({
      sessionId: "session-1",
      commandId: "command-1",
      hostId: "host-1",
      claimAttempt: 3,
      resultEnvelope,
    });
  });
});
