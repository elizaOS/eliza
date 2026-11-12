import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cloudSpeechRecoveryJournal } from "../../../app/src/api/cloud-speech-recovery-journal";
import {
  type CloudSpeechRelayRetirement,
  createCloudSpeechRelayPorts,
} from "./cloud-speech-relay-client";
import {
  SPEECH_ADMISSION_OUTCOME_HEADER,
  SPEECH_MINT_INTENT_HEADER,
  SPEECH_RECOVERY_HEADER,
} from "./speech-relay-wire";

const nonce = "11111111-1111-4111-8111-111111111111";
function fixture(
  mint: (init: RequestInit) => Response | Promise<Response>,
  capable = true,
) {
  let retirement!: CloudSpeechRelayRetirement;
  const paths: string[] = [];
  const start = createCloudSpeechRelayPorts({
    enabled: true,
    origin: "https://api.eliza.app",
    credential: async () => "fixture-key",
    assertCurrent() {},
    registerRetirement(value) {
      retirement = value;
    },
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith("/consent"))
        return Response.json({
          consentNonce: nonce,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          ...(capable ? { retirementProofVersion: 1 } : {}),
        });
      if (path.endsWith("/session")) {
        expect(new Headers(init?.headers).get(SPEECH_MINT_INTENT_HEADER)).toBe(
          nonce,
        );
        if (!init) throw Error("Missing mint request options");
        return mint(init);
      }
      throw Error("Unexpected revoke without a known session identity");
    }) as typeof fetch,
    websocket() {
      throw Error("A rejected mint must not open a socket");
    },
  });
  return { start, paths, retirement: () => retirement };
}
test.each([403, 429, 503])(
  "authoritative pre-admission %i can retire without a session",
  async (status) => {
    const f = fixture(() =>
      Response.json(
        { error: "denied" },
        {
          status,
          headers: {
            [SPEECH_ADMISSION_OUTCOME_HEADER]: `not-created-v1:${nonce}`,
          },
        },
      ),
    );
    await expect(f.start).rejects.toBeInstanceOf(Error);
    await expect(f.retirement().close()).resolves.toBeUndefined();
    expect(f.paths).toHaveLength(2);
  },
);
test("unattested HTTP failure retains the unknown admission fence", async () => {
  const f = fixture(() =>
    Response.json({ error: "ambiguous" }, { status: 503 }),
  );
  await expect(f.start).rejects.toBeInstanceOf(Error);
  const retry = f.retirement().retryRetirement;
  assert(retry);
  await expect(retry()).rejects.toThrow("unconfirmed");
});
test("a lost mint response retains the unknown admission fence", async () => {
  const f = fixture(() => {
    throw Error("response lost after server may initialize");
  });
  await expect(f.start).rejects.toBeInstanceOf(Error);
  const retry = f.retirement().retryRetirement;
  assert(retry);
  await expect(retry()).rejects.toThrow("unconfirmed");
});
test("a mismatched rejection intent cannot clear another admission", async () => {
  const f = fixture(() =>
    Response.json(
      {},
      {
        status: 403,
        headers: {
          [SPEECH_ADMISSION_OUTCOME_HEADER]:
            "not-created-v1:22222222-2222-4222-8222-222222222222",
        },
      },
    ),
  );
  await expect(f.start).rejects.toBeInstanceOf(Error);
  const retry = f.retirement().retryRetirement;
  assert(retry);
  await expect(retry()).rejects.toThrow("unconfirmed");
});
test("an old consent response is rejected before mint dispatch", async () => {
  const f = fixture(() => {
    throw Error("must not mint");
  }, false);
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().close()).resolves.toBeUndefined();
  expect(f.paths).toHaveLength(1);
});

test.each(["not-json", "{}"])(
  "malformed successful mint %s keeps the unknown fence",
  async (body) => {
    const f = fixture(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(f.start).rejects.toBeInstanceOf(Error);
    const retry = f.retirement().retryRetirement;
    assert(retry);
    await expect(retry()).rejects.toThrow("unconfirmed");
  },
);

for (const status of [403, 429, 503]) {
  test(`real-response origin permits attested ${status} denial`, async () => {
    const f = fixture(() => {
      const response = Response.json(
        {},
        {
          status,
          headers: {
            [SPEECH_ADMISSION_OUTCOME_HEADER]: `not-created-v1:${nonce}`,
          },
        },
      );
      Object.defineProperty(response, "url", {
        value: "https://api.eliza.app/api/v1/voice/speech/session",
      });
      return response;
    });
    await expect(f.start).rejects.toBeInstanceOf(Error);
    await expect(f.retirement().close()).resolves.toBeUndefined();
  });
}
test("a populated foreign response origin cannot attest rejection", async () => {
  const f = fixture(() => {
    const response = Response.json(
      {},
      {
        status: 403,
        headers: {
          [SPEECH_ADMISSION_OUTCOME_HEADER]: `not-created-v1:${nonce}`,
        },
      },
    );
    Object.defineProperty(response, "url", {
      value: "https://foreign.example/api/v1/voice/speech/session",
    });
    return response;
  });
  await expect(f.start).rejects.toBeInstanceOf(Error);
  await expect(f.retirement().close()).rejects.toThrow("unconfirmed");
});

test.each([403, 429, 503])(
  "real loopback fetch preserves attested %i rejection",
  async (status) => {
    let retirement!: CloudSpeechRelayRetirement;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/consent")) {
        response.end(
          JSON.stringify({
            consentNonce: nonce,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            retirementProofVersion: 1,
          }),
        );
      } else {
        response.statusCode = status;
        response.setHeader(
          SPEECH_ADMISSION_OUTCOME_HEADER,
          `not-created-v1:${nonce}`,
        );
        response.end(JSON.stringify({ error: "denied" }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing loopback port");
      await expect(
        createCloudSpeechRelayPorts({
          enabled: true,
          allowInsecureLoopback: true,
          origin: `http://127.0.0.1:${address.port}`,
          credential: async () => "test-only",
          assertCurrent() {},
          registerRetirement: (value) => {
            retirement = value;
          },
          fetch: globalThis.fetch,
          websocket() {
            throw Error("Rejected mint must not open a provider");
          },
        }),
      ).rejects.toBeInstanceOf(Error);
      await expect(retirement.close()).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test("restart uses its journal to retire the exact prior session before a new mint", async () => {
  const root = await mkdtemp(join(tmpdir(), "speech-recovery-"));
  const owner = "local-owner";
  const origin = "https://api.eliza.app";
  const conversation = "conversation";
  const previous = crypto.randomUUID();
  const prepared = "55555555-5555-5555-8555-555555555555";
  const events: string[] = [];
  const journal = cloudSpeechRecoveryJournal(root, owner, origin, conversation);
  try {
    await journal.record(previous);
    const reopened = cloudSpeechRecoveryJournal(
      root,
      owner,
      origin,
      conversation,
    );
    expect(await reopened.pending()).toEqual([previous]);
    expect(
      await cloudSpeechRecoveryJournal(
        root,
        "other-owner",
        origin,
        conversation,
      ).pending(),
    ).toEqual([]);
    expect(
      await cloudSpeechRecoveryJournal(
        root,
        owner,
        "https://different.invalid",
        conversation,
      ).pending(),
    ).toEqual([]);
    const start = createCloudSpeechRelayPorts({
      enabled: true,
      origin,
      credential: async () => "current-owner-key",
      assertCurrent() {},
      recoveryJournal: reopened,
      fetch: (async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/revoke")) {
          const id = path.split("/").at(-2);
          if (!id) throw Error("Missing retirement session ID");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer current-owner-key",
          );
          events.push(`revoke:${id}`);
          return Response.json({
            revoked: true,
            retirement: {
              version: 1,
              sessionId: id,
              state: "confirmed",
              mode: "never_started",
              stt: "not_dispatched",
              tts: "not_dispatched",
              accounting: "not_started",
              completedAt: new Date().toISOString(),
            },
          });
        }
        expect(new Headers(init?.headers).get(SPEECH_RECOVERY_HEADER)).toBe(
          "1",
        );
        if (path.endsWith("/consent")) {
          events.push("consent");
          expect(await reopened.pending()).toEqual([]);
          return Response.json({
            consentNonce: nonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            retirementProofVersion: 1,
            recoverySessionId: prepared,
          });
        }
        expect(path.endsWith("/session")).toBe(true);
        expect(JSON.parse(String(init?.body))).toEqual({
          consentNonce: nonce,
          recoverySessionId: prepared,
        });
        expect(await reopened.pending()).toEqual([prepared]);
        events.push("lost-mint");
        throw Error("mint response lost");
      }) as typeof fetch,
      websocket() {
        throw Error("No socket should open after a lost mint");
      },
    });
    await expect(start).rejects.toThrow("mint response lost");
    expect(events).toEqual([
      `revoke:${previous}`,
      "consent",
      "lost-mint",
      `revoke:${prepared}`,
    ]);
    expect(await reopened.pending()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["admit", "cancel", "owner-change", "retirement-unknown", "expired"])(
  "successor consent prewarms without provider admission: %s",
  async (outcome) => {
    const previous = crypto.randomUUID();
    const prepared = "55555555-5555-5555-8555-555555555555";
    const pending = new Set([previous]);
    const events: string[] = [];
    const controller = new AbortController();
    let current = true;
    let release!: () => void;
    let signalPrepared!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signalPrepared = resolve;
    });
    const start = createCloudSpeechRelayPorts({
      enabled: true,
      origin: "https://api.eliza.app",
      credential: async () => "current-owner-key",
      signal: controller.signal,
      assertCurrent() {
        if (!current) throw Error("owner changed");
      },
      recoveryJournal: {
        async pending() {
          return [...pending];
        },
        async record(id) {
          pending.add(id);
        },
        async clear(id) {
          pending.delete(id);
        },
      },
      async beforeProviderAdmission() {
        signalPrepared();
        await gate;
      },
      fetch: (async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/consent")) {
          events.push("consent");
          return Response.json({
            consentNonce: nonce,
            expiresAt: new Date(
              Date.now() + (outcome === "expired" ? 20 : 60000),
            ).toISOString(),
            retirementProofVersion: 1,
            recoverySessionId: prepared,
          });
        }
        if (path.endsWith("/revoke")) {
          const id = path.split("/").at(-2);
          if (!id) throw Error("Missing retirement ID");
          events.push(`revoke:${id}`);
          if (id === previous && outcome === "retirement-unknown")
            return Response.json({}, { status: 503 });
          return Response.json({
            revoked: true,
            retirement: {
              version: 1,
              sessionId: id,
              state: "confirmed",
              mode: "never_started",
              stt: "not_dispatched",
              tts: "not_dispatched",
              accounting: "not_started",
              completedAt: new Date().toISOString(),
            },
          });
        }
        events.push("mint");
        throw Error("mint response lost");
      }) as typeof fetch,
      websocket() {
        throw Error("No provider socket expected");
      },
    });
    // Observe rejection immediately; the barrier deliberately keeps startup pending.
    const result = start.then(
      () => null,
      (error: unknown) => error,
    );
    await ready;
    expect(events).toEqual(["consent"]);
    expect([...pending]).toEqual([previous, prepared]);
    if (outcome === "cancel") controller.abort();
    if (outcome === "owner-change") current = false;
    if (outcome === "expired")
      await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    expect(await result).toBeInstanceOf(Error);
    expect(events.includes("mint")).toBe(outcome === "admit");
    expect(events.at(-1)).toBe(`revoke:${prepared}`);
    expect(pending.has(prepared)).toBe(false);
    expect(pending.has(previous)).toBe(
      ["cancel", "owner-change", "retirement-unknown"].includes(outcome),
    );
    if (outcome === "admit")
      expect(events).toEqual([
        "consent",
        `revoke:${previous}`,
        "mint",
        `revoke:${prepared}`,
      ]);
  },
);
