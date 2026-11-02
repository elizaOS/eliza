import { beforeEach, expect, test, mock } from "bun:test";
const data = { generated: 0, owner: 0, calls: [] as any[] };
mock.module("@elizaos/cloud-shared/auth", () => ({ requireUserOrApiKeyWithOrg: async () => { data.owner++; return { id: "owner", organization_id: "org" }; } }));
mock.module("./lib/generative-route-auth", () => ({ requireGenerativeRouteCaller: async () => { data.generated++; return { user: { id: "owner", organization_id: "org" }, credential: { kind: "api_key" } }; } }));
mock.module("@elizaos/cloud-shared/lib/voice-session/consent-nonce", () => ({ issueConsentNonce: async () => ({ nonce: "00000000-0000-4000-8000-000000000001", expiresAt: new Date(Date.now() + 60000).toISOString() }), consumeConsentNonce: async () => true }));
mock.module("./speech-relay-coordinator", () => ({ speechTokenDigest: () => "a".repeat(64) }));
const { default: app } = await import("../v1/voice/speech/route");
const nonce = "00000000-0000-4000-8000-000000000001";
const env = (enabled = true, proof = true) => ({ VOICE_SPEECH_RELAY_ENABLED: String(enabled), VOICE_SPEECH_RETIREMENT_PROOF_ENABLED: String(proof), SPEECH_RELAY_SESSIONS: { getByName: () => ({ fetch: async (url: unknown, init: any) => { data.calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ initialized: true }); } }) } });
beforeEach(() => { data.generated = 0; data.owner = 0; data.calls = []; });
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
