import { expect, test } from "vitest";
import { createCloudSpeechRelayPorts, type CloudSpeechRelayRetirement } from "./cloud-speech-relay-client";
import { SPEECH_ADMISSION_OUTCOME_HEADER, SPEECH_MINT_INTENT_HEADER } from "./speech-relay-wire";

const nonce = "11111111-1111-4111-8111-111111111111";
function fixture(mint: (init: RequestInit) => Response | Promise<Response>, capable = true) {
  let retirement!: CloudSpeechRelayRetirement;
  const paths: string[] = [];
  const start = createCloudSpeechRelayPorts({
    enabled: true, origin: "https://api.eliza.app", credential: async () => "fixture-key",
    assertCurrent() {}, registerRetirement(value) { retirement = value; },
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith("/consent")) return Response.json({ consentNonce: nonce, expiresAt: new Date(Date.now() + 60000).toISOString(), ...(capable ? { retirementProofVersion: 1 } : {}) });
      if (path.endsWith("/session")) {
        expect(new Headers(init?.headers).get(SPEECH_MINT_INTENT_HEADER)).toBe(nonce);
        return mint(init!);
      }
      throw Error("Unexpected revoke without a known session identity");
    }) as typeof fetch,
    websocket() { throw Error("A rejected mint must not open a socket"); },
  });
  return { start, paths, retirement: () => retirement };
}
test.each([403, 429, 503])("authoritative pre-admission %i can retire without a session", async status => {
  const f = fixture(() => Response.json({ error: "denied" }, { status, headers: { [SPEECH_ADMISSION_OUTCOME_HEADER]: `not-created-v1:${nonce}` } }));
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().close()).resolves.toBeUndefined();
  expect(f.paths).toHaveLength(2);
});
test("unattested HTTP failure retains the unknown admission fence", async () => {
  const f = fixture(() => Response.json({ error: "ambiguous" }, { status: 503 }));
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().retryRetirement!()).rejects.toThrow("unconfirmed");
});
test("a lost mint response retains the unknown admission fence", async () => {
  const f = fixture(() => { throw Error("response lost after server may initialize"); });
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().retryRetirement!()).rejects.toThrow("unconfirmed");
});
test("a mismatched rejection intent cannot clear another admission", async () => {
  const f = fixture(() => Response.json({}, { status: 403, headers: { [SPEECH_ADMISSION_OUTCOME_HEADER]: "not-created-v1:22222222-2222-4222-8222-222222222222" } }));
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().retryRetirement!()).rejects.toThrow("unconfirmed");
});
test("an old consent response is rejected before mint dispatch", async () => {
  const f = fixture(() => { throw Error("must not mint"); }, false);
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().close()).resolves.toBeUndefined();
  expect(f.paths).toHaveLength(1);
});

test.each(["not-json", "{}"])("malformed successful mint %s keeps the unknown fence", async body => {
  const f = fixture(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().retryRetirement!()).rejects.toThrow("unconfirmed");
});
