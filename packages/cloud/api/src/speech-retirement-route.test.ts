import { beforeEach, expect, test, mock } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { SPEECH_MINT_INTENT_HEADER, SPEECH_ADMISSION_OUTCOME_HEADER } from "@elizaos/host/voice/speech-relay-wire";
const data = { generated: 0, owner: 0, calls: [] as any[], authStatus: undefined as 429 | undefined, initializeStatus: 200, initializeThrows: false };
mock.module("@elizaos/cloud-shared/auth", () => ({ requireUserOrApiKeyWithOrg: async () => { data.owner++; return { id: "owner", organization_id: "org" }; } }));
mock.module("./lib/generative-route-auth", () => ({ requireGenerativeRouteCaller: async () => { data.generated++; if (data.authStatus) throw new HTTPException(data.authStatus); return { user: { id: "owner", organization_id: "org" }, credential: { kind: "api_key" } }; } }));
mock.module("@elizaos/cloud-shared/lib/voice-session/consent-nonce", () => ({ issueConsentNonce: async () => ({ nonce: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(Date.now() + 60000).toISOString() }), consumeConsentNonce: async () => true }));
mock.module("./speech-relay-coordinator", () => ({ speechTokenDigest: () => "a".repeat(64) }));
const { default: app } = await import("../v1/voice/speech/route");
const nonce = "00000000-0000-4000-8000-000000000001";
const env = (enabled = true, proof = true) => ({ VOICE_SPEECH_RELAY_ENABLED: String(enabled), VOICE_SPEECH_RETIREMENT_PROOF_ENABLED: String(proof), SPEECH_RELAY_SESSIONS: { getByName: () => ({ fetch: async (url: unknown, init: any) => { data.calls.push({ url, body: JSON.parse(init.body) }); if (data.initializeThrows) throw Error("lost initialize acknowledgement"); return Response.json({ initialized: true }, { status: data.initializeStatus }); } }) } });
beforeEach(() => { data.generated = 0; data.owner = 0; data.calls = []; data.authStatus = undefined; data.initializeStatus = 200; data.initializeThrows = false; });
test("legacy mint shape is unchanged without opt-in", async () => {
  const res = await app.request("/session", { method: "POST", body: JSON.stringify({ consentNonce: nonce }) }, env() as never);
  expect(res.status).toBe(200); expect((await res.json()).retirementProofVersion).toBeUndefined(); expect(data.calls[0].body.proofVersion).toBeUndefined();
});
test("new mint persists and acknowledges requested proof version", async () => {
  const res = await app.request("/session", { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "1" }, body: JSON.stringify({ consentNonce: nonce }) }, env() as never);
  expect((await res.json()).retirementProofVersion).toBe(1); expect(data.calls[0].body.proofVersion).toBe(1);
});
test("unsupported proof is refused before admission", async () => {
  const res = await app.request("/session", { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "1" } }, env(true, false) as never);
  expect(res.status).toBe(503); expect(data.calls).toHaveLength(0);
});
test("flag-off revoke uses current owner auth rather than paid admission", async () => {
  const res = await app.request(`/session/${nonce}/revoke`, { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "1" } }, env(false, false) as never);
  expect(res.status).toBe(200); expect(data.owner).toBe(1); expect(data.generated).toBe(0);
  expect(data.calls[0].body).toEqual({ userId: "owner", organizationId: "org", proofVersion: 1 });
});
test("bad requested version is not treated as legacy", async () => {
  const res = await app.request("/session", { method: "POST", headers: { "X-Eliza-Speech-Retirement-Version": "2" } }, env() as never);
  expect(res.status).toBe(400); expect(data.calls).toHaveLength(0);
});

const requested = { "X-Eliza-Speech-Retirement-Version": "1", [SPEECH_MINT_INTENT_HEADER]: nonce };
test("pre-initialize rejection is bound to the exact request intent", async () => {
  const response = await app.request("/session", { method: "POST", headers: requested, body: "{}" }, env() as never);
  expect(response.status).toBe(400); expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBe(`not-created-v1:${nonce}`); expect(data.calls).toHaveLength(0);
});
test("auth rejection before initialization retains the no-allocation attestation", async () => {
  data.authStatus = 429;
  const response = await app.request("/session", { method: "POST", headers: requested, body: JSON.stringify({ consentNonce: nonce }) }, env() as never);
  expect(response.status).toBe(429); expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBe(`not-created-v1:${nonce}`); expect(data.calls).toHaveLength(0);
});
test("initialization failure cannot carry a no-allocation attestation", async () => {
  data.initializeStatus = 503;
  const response = await app.request("/session", { method: "POST", headers: requested, body: JSON.stringify({ consentNonce: nonce }) }, env() as never);
  expect(response.status).toBe(503); expect(response.headers.get(SPEECH_ADMISSION_OUTCOME_HEADER)).toBeNull(); expect(data.calls).toHaveLength(1);
});
