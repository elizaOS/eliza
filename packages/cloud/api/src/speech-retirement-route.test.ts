import { beforeEach, expect, mock, test } from "bun:test";
import {
  SPEECH_ADMISSION_OUTCOME_HEADER,
  SPEECH_MINT_INTENT_HEADER,
  SPEECH_RECOVERY_HEADER,
  SPEECH_RELAY_EXTEND_HEADER,
} from "@elizaos/host/voice/speech-relay-wire";
import { HTTPException } from "hono/http-exception";

const data = {
  generated: 0,
  issued: 0,
  consumed: 0,
  owner: 0,
  calls: [] as { url: unknown; body: Record<string, unknown> }[],
  authStatus: undefined as 429 | undefined,
  initializeStatus: 200,
  initializeThrows: false,
};
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    data.owner++;
    return { id: "owner", organization_id: "org" };
  },
}));
mock.module("./lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller: async () => {
    data.generated++;
    if (data.authStatus) throw new HTTPException(data.authStatus);
    return {
      user: { id: "owner", organization_id: "org" },
      credential: { kind: "api_key" },
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/voice-session/consent-nonce", () => ({
  CONSENT_NONCE_TTL_SECONDS: 300,
  issueConsentNonce: async () => {
    data.issued++;
    return {
      nonce: "00000000-0000-4000-8000-000000000001",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  },
  consumeConsentNonce: async () => {
    data.consumed++;
    return true;
  },
}));
const coordinator = await import("./speech-relay-coordinator");
mock.module("./speech-relay-coordinator", () => ({
  ...coordinator,
  speechTokenDigest: () => "a".repeat(64),
}));
const { default: app } = await import("../v1/voice/speech/route");
const nonce = "00000000-0000-4000-8000-000000000001";
const env = (enabled = true, proof = true) => ({
  VOICE_SPEECH_RELAY_ENABLED: String(enabled),
  VOICE_SPEECH_RETIREMENT_PROOF_ENABLED: String(proof),
  SPEECH_RELAY_SESSIONS: {
    getByName: () => ({
      fetch: async (url: unknown, init: RequestInit) => {
        if (typeof init.body !== "string") throw Error("Expected JSON request");
        const body: unknown = JSON.parse(init.body);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw Error("Expected JSON request object");
        data.calls.push({ url, body: body as Record<string, unknown> });
        if (data.initializeThrows)
          throw Error("lost initialize acknowledgement");
        return Response.json(
          { initialized: true },
          { status: data.initializeStatus },
        );
      },
    }),
  },
});
beforeEach(() => {
  data.generated = 0;
  data.issued = 0;
  data.consumed = 0;
  data.owner = 0;
  data.calls = [];
  data.authStatus = undefined;
  data.initializeStatus = 200;
  data.initializeThrows = false;
});
test("legacy mint shape is unchanged without opt-in", async () => {
  const res = await app.request(
    "/session",
    { method: "POST", body: JSON.stringify({ consentNonce: nonce }) },
    env() as never,
  );
  expect(res.status).toBe(200);
  expect((await responseObject(res)).retirementProofVersion).toBeUndefined();
  expect(data.calls[0].body.proofVersion).toBeUndefined();
});
test("new mint persists and acknowledges requested proof version", async () => {
  const res = await app.request(
    "/session",
    {
      method: "POST",
      headers: { "X-Eliza-Speech-Retirement-Version": "1" },
      body: JSON.stringify({ consentNonce: nonce }),
    },
    env() as never,
  );
  expect(res.headers.get(SPEECH_RELAY_EXTEND_HEADER)).toBeNull();
  expect((await responseObject(res)).retirementProofVersion).toBe(1);
  expect(data.calls[0].body.proofVersion).toBe(1);
});
test("recovery consent returns the exact prepared ID that a later mint uses", async () => {
  const headers = {
    "X-Eliza-Speech-Retirement-Version": "1",
    [SPEECH_RECOVERY_HEADER]: "1",
  };
  const consent = await app.request(
    "/consent",
    { method: "POST", headers },
    env() as never,
  );
  expect(consent.status).toBe(200);
  const body = await responseObject(consent);
  const recoverySessionId = body.recoverySessionId;
  const consentNonce = body.consentNonce;
  expect(data.issued).toBe(0);
  expect(typeof recoverySessionId).toBe("string");
  expect(data.calls[0]).toMatchObject({
    url: "https://speech-relay.internal/prepare",
    body: { sessionId: recoverySessionId, proofVersion: 1 },
  });
  const mint = await app.request(
    "/session",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ consentNonce, recoverySessionId }),
    },
    env() as never,
  );
  expect(mint.status).toBe(200);
  expect(data.consumed).toBe(0);
  expect(mint.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBeNull();
  expect((await responseObject(mint)).sessionId).toBe(recoverySessionId);
  expect(data.calls[1]).toMatchObject({
    url: "https://speech-relay.internal/initialize",
    body: {
      sessionId: recoverySessionId,
      consentDigest: "a".repeat(64),
      proofVersion: 1,
    },
  });
});
test("older random recovery IDs retain their Redis consent precondition", async () => {
  const response = await app.request(
    "/session",
    {
      method: "POST",
      headers: {
        "X-Eliza-Speech-Retirement-Version": "1",
        [SPEECH_RECOVERY_HEADER]: "1",
      },
      body: JSON.stringify({
        consentNonce: nonce,
        recoverySessionId: "44444444-4444-4444-8444-444444444444",
      }),
    },
    env() as never,
  );
  expect(response.status).toBe(200);
  expect(data.consumed).toBe(1);
});

test("a deterministic recovery name still requires a valid prepared ledger", async () => {
  const { preparedSpeechSessionIdForConsent } = await import(
    "./speech-relay-coordinator"
  );
  data.initializeStatus = 409;
  const response = await app.request(
    "/session",
    {
      method: "POST",
      headers: {
        "X-Eliza-Speech-Retirement-Version": "1",
        [SPEECH_RECOVERY_HEADER]: "1",
      },
      body: JSON.stringify({
        consentNonce: nonce,
        recoverySessionId: preparedSpeechSessionIdForConsent("owner", nonce),
      }),
    },
    env() as never,
  );
  expect(response.status).toBe(503);
  expect(data.consumed).toBe(0);
  expect(data.calls).toHaveLength(1);
  expect(data.calls[0].body.consentDigest).toBe("a".repeat(64));
});

test("unsupported proof is refused before admission", async () => {
  const res = await app.request(
    "/session",
    { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "1" } },
    env(true, false) as never,
  );
  expect(res.status).toBe(503);
  expect(data.calls).toHaveLength(0);
});
test("flag-off revoke uses current owner auth rather than paid admission", async () => {
  const res = await app.request(
    `/session/${nonce}/revoke`,
    { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "1" } },
    env(false, false) as never,
  );
  expect(res.status).toBe(200);
  expect(data.owner).toBe(1);
  expect(data.generated).toBe(0);
  expect(data.calls[0].body).toEqual({
    userId: "owner",
    organizationId: "org",
    proofVersion: 1,
  });
});
test("bad requested version is not treated as legacy", async () => {
  const res = await app.request(
    "/session",
    { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "2" } },
    env() as never,
  );
  expect(res.status).toBe(400);
  expect(data.calls).toHaveLength(0);
});

const requested = {
  "X-Eliza-Speech-Retirement-Version": "1",
  [SPEECH_MINT_INTENT_HEADER]: nonce,
};
test("pre-initialize rejection is bound to the exact request intent", async () => {
  const response = await app.request(
    "/session",
    { method: "POST", headers: requested, body: "{}" },
    env() as never,
  );
  expect(response.status).toBe(400);
  expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBe(
    `not-created-v1:${nonce}`,
  );
  expect(data.calls).toHaveLength(0);
});
test("auth rejection before initialization retains the no-allocation attestation", async () => {
  data.authStatus = 429;
  const response = await app.request(
    "/session",
    {
      method: "POST",
      headers: requested,
      body: JSON.stringify({ consentNonce: nonce }),
    },
    env() as never,
  );
  expect(response.status).toBe(429);
  expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBe(
    `not-created-v1:${nonce}`,
  );
  expect(data.calls).toHaveLength(0);
});
test("initialization failure cannot carry a no-allocation attestation", async () => {
  data.initializeStatus = 503;
  const response = await app.request(
    "/session",
    {
      method: "POST",
      headers: requested,
      body: JSON.stringify({ consentNonce: nonce }),
    },
    env() as never,
  );
  expect(response.status).toBe(503);
  expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBeNull();
  expect(data.calls).toHaveLength(1);
});

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
async function responseObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isJsonRecord(value))
    throw Error("Expected speech route response object");
  return value;
}
