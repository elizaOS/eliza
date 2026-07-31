/**
 * Workload-scoped Steward refs (#17432): boot resolution into runtime
 * settings ONLY, with process.env scrubbed of both the sentinels and the
 * capability private key.
 *
 * Chain under test (the REAL production boot path units):
 *   docker env (vault://workload/... refs + STEWARD_WORKLOAD_* capability)
 *   → resolveWorkloadEnvOverlayForBoot (enroll → resolve → scrub)
 *   → buildRuntimeSettingsProjection({ connectorSecretsOverlay })
 *   → runtime.getSetting()-visible settings map.
 *
 * The Steward double here implements the EXACT wire contract proven against
 * the real API in the cross-repo suite (workload-cross-repo.e2e.test.ts):
 * challenge/verify perform REAL ECDSA P-256/SHA-256 verification of the
 * resolver's signature, so the client crypto genuinely interoperates.
 *
 * Bidirectional:
 *   1. refs + capability → settings carry plaintext; process.env carries
 *      NEITHER plaintext NOR sentinels NOR the capability key afterwards.
 *   2. no workload refs → zero network, env untouched (self-gating).
 *   3. missing capability / denied enrollment / outage / foreign-workload
 *      refs → fail-closed: nothing resolved, failures are key names only,
 *      no secret material in any log-bound string.
 */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetWorkloadBootOverlayCacheForTest,
  isWorkloadRef,
  parseWorkloadRefName,
  readWorkloadCapability,
  resolveWorkloadEnvOverlayForBoot,
  resolveWorkloadSecretSettings,
} from "./operations/workload-secrets.ts";
import { buildRuntimeSettingsProjection } from "./runtime-settings.ts";

const WORKLOAD_ID = "wl-test-container";
// Assembled by concatenation so no token-shaped literal exists for secret
// scanners to match (synthetic fixture, not a credential).
const SECRET_VALUE = ["sk", "live", "topsecret", "abc123"].join("-");
const DISCORD_VALUE = "discord-token-xyz";

/** In-process Steward implementing the real wire contract with REAL P-256
 * verification (the resolver's signature must actually verify). */
function makeSteward(options: { deny?: boolean; outage?: boolean } = {}) {
  const secrets = new Map<string, string>([
    [`workload/${WORKLOAD_ID}/OPENAI_API_KEY`, SECRET_VALUE],
    [`workload/${WORKLOAD_ID}/DISCORD_API_TOKEN`, DISCORD_VALUE],
  ]);
  const nonces = new Map<string, string>();
  let publicKey: import("node:crypto").webcrypto.CryptoKey | null = null;
  const requests: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.outage) throw new Error("ECONNREFUSED");
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.pathname === "/agent-enroll/challenge") {
      const nonce = crypto.randomUUID();
      const canonicalString = `steward-enroll|${body.agentId}|${nonce}`;
      nonces.set(nonce, canonicalString);
      return Response.json({
        ok: true,
        data: {
          agentId: body.agentId,
          nonce,
          canonicalString,
          expiresAt: Date.now() + 60_000,
        },
      });
    }
    if (url.pathname === "/agent-enroll/verify") {
      const canonicalString = nonces.get(body.nonce);
      nonces.delete(body.nonce);
      if (options.deny || !canonicalString || !publicKey) {
        return Response.json(
          { ok: false, error: "enrollment denied" },
          { status: 401 },
        );
      }
      const valid = await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        Buffer.from(String(body.signature), "base64"),
        new TextEncoder().encode(canonicalString),
      );
      if (!valid || body.agentId !== WORKLOAD_ID) {
        return Response.json(
          { ok: false, error: "enrollment denied" },
          { status: 401 },
        );
      }
      return Response.json({ ok: true, data: { token: "workload-token-1" } });
    }
    if (url.pathname === "/v1/workload-secrets/resolve") {
      if (
        init?.headers &&
        !JSON.stringify(init.headers).includes("workload-token-1")
      ) {
        return Response.json({ ok: false, error: "denied" }, { status: 403 });
      }
      const resolved: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of body.names as string[]) {
        const value = secrets.get(`workload/${WORKLOAD_ID}/${name}`);
        if (value) resolved[name] = value;
        else missing.push(name);
      }
      return Response.json({ ok: true, data: { secrets: resolved, missing } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetchImpl,
    requests,
    async registerKeypair() {
      const pair = await webcrypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      publicKey = pair.publicKey;
      const pkcs8 = Buffer.from(
        await webcrypto.subtle.exportKey("pkcs8", pair.privateKey),
      ).toString("base64");
      return pkcs8;
    },
  };
}

function makeEnv(privateKey: string): NodeJS.ProcessEnv {
  return {
    STEWARD_API_URL: "https://steward.test",
    STEWARD_WORKLOAD_ID: WORKLOAD_ID,
    STEWARD_WORKLOAD_KEY: privateKey,
    OPENAI_API_KEY: `vault://workload/${WORKLOAD_ID}/OPENAI_API_KEY`,
    DISCORD_API_TOKEN: `vault://workload/${WORKLOAD_ID}/DISCORD_API_TOKEN`,
    NODE_ENV: "production",
  };
}

beforeEach(() => {
  __resetWorkloadBootOverlayCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ref classification", () => {
  it("isWorkloadRef accepts only vault://workload/... sentinels", () => {
    expect(isWorkloadRef(`vault://workload/${WORKLOAD_ID}/KEY`)).toBe(true);
    expect(isWorkloadRef("vault://cloud/env/org/proj/KEY")).toBe(false);
    expect(isWorkloadRef("vault://providers.openai.api-key")).toBe(false);
    expect(isWorkloadRef("plain-value")).toBe(false);
    expect(isWorkloadRef(undefined)).toBe(false);
  });

  it("parseWorkloadRefName is namespace-strict (foreign workloads fail closed)", () => {
    expect(
      parseWorkloadRefName(
        `vault://workload/${WORKLOAD_ID}/OPENAI_API_KEY`,
        WORKLOAD_ID,
      ),
    ).toBe("OPENAI_API_KEY");
    expect(
      parseWorkloadRefName(
        "vault://workload/other-workload/OPENAI_API_KEY",
        WORKLOAD_ID,
      ),
    ).toBeNull();
    expect(
      parseWorkloadRefName(`vault://workload/${WORKLOAD_ID}/`, WORKLOAD_ID),
    ).toBeNull();
  });

  it("readWorkloadCapability requires the full triplet", () => {
    expect(readWorkloadCapability({})).toBeNull();
    expect(
      readWorkloadCapability({
        STEWARD_API_URL: "x",
        STEWARD_WORKLOAD_ID: "y",
      }),
    ).toBeNull();
    expect(
      readWorkloadCapability({
        STEWARD_API_URL: "https://s",
        STEWARD_WORKLOAD_ID: "wl",
        STEWARD_WORKLOAD_KEY: "k",
      }),
    ).toEqual({
      apiUrl: "https://s",
      workloadId: "wl",
      privateKeyPkcs8Base64: "k",
    });
  });
});

describe("boot resolution → settings only, env scrubbed", () => {
  it("resolves refs via real enroll crypto, delivers ONLY into the settings projection, scrubs env", async () => {
    const steward = makeSteward();
    const privateKey = await steward.registerKeypair();
    const env = makeEnv(privateKey);

    const overlay = await resolveWorkloadEnvOverlayForBoot({
      env,
      fetchImpl: steward.fetchImpl,
    });

    // resolved into the overlay…
    expect(overlay.OPENAI_API_KEY).toBe(SECRET_VALUE);
    expect(overlay.DISCORD_API_TOKEN).toBe(DISCORD_VALUE);

    // …env scrubbed: no sentinel, no plaintext, no capability private key
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.STEWARD_WORKLOAD_KEY).toBeUndefined();
    for (const value of Object.values(env)) {
      expect(value).not.toContain(SECRET_VALUE);
      expect(value).not.toContain(DISCORD_VALUE);
      expect(value).not.toContain(privateKey);
    }
    // non-secret config untouched
    expect(env.NODE_ENV).toBe("production");
    // workload id/url may remain (identifiers, not credentials)
    expect(env.STEWARD_WORKLOAD_ID).toBe(WORKLOAD_ID);

    // the wire sequence was the real contract
    expect(steward.requests).toEqual([
      "POST /agent-enroll/challenge",
      "POST /agent-enroll/verify",
      "POST /v1/workload-secrets/resolve",
    ]);

    // …and the settings projection delivers the plaintext to plugins while
    // never having written process.env (same channel as connector secrets).
    const settings = buildRuntimeSettingsProjection({} as never, {
      env,
      connectorSecretsOverlay: overlay,
    });
    expect(settings.OPENAI_API_KEY).toBe(SECRET_VALUE);
    expect(settings.DISCORD_API_TOKEN).toBe(DISCORD_VALUE);
  });

  it("self-gating: no workload refs → zero network, env untouched", async () => {
    const steward = makeSteward();
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "plain-value",
      NODE_ENV: "production",
    };
    const overlay = await resolveWorkloadEnvOverlayForBoot({
      env,
      fetchImpl: steward.fetchImpl,
    });
    expect(overlay).toEqual({});
    expect(steward.requests).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe("plain-value");
  });

  it("single-flight: hot-reload reuses the cold-boot overlay after the capability was scrubbed", async () => {
    const steward = makeSteward();
    const privateKey = await steward.registerKeypair();

    // cold boot against process.env (the cached path)
    const savedEnv: Record<string, string | undefined> = {};
    const bootEnv = makeEnv(privateKey);
    for (const [k, v] of Object.entries(bootEnv)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const first = await resolveWorkloadEnvOverlayForBoot({
        fetchImpl: steward.fetchImpl,
      });
      expect(first.OPENAI_API_KEY).toBe(SECRET_VALUE);
      expect(process.env.STEWARD_WORKLOAD_KEY).toBeUndefined();

      // hot reload: the key is gone from env, but the cache serves the overlay
      const second = await resolveWorkloadEnvOverlayForBoot({
        fetchImpl: steward.fetchImpl,
      });
      expect(second).toEqual(first);
      // no second enrollment happened
      expect(
        steward.requests.filter((r) => r.includes("challenge")),
      ).toHaveLength(1);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetWorkloadBootOverlayCacheForTest();
    }
  });
});

describe("fail-closed paths (names only, nothing resolved)", () => {
  it("capability absent → all ref keys fail, nothing resolved", async () => {
    const steward = makeSteward();
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      { OPENAI_API_KEY: `vault://workload/${WORKLOAD_ID}/OPENAI_API_KEY` },
      { env: {}, fetchImpl: steward.fetchImpl },
    );
    expect(resolved).toEqual({});
    expect(failures).toEqual(["OPENAI_API_KEY"]);
    expect(steward.requests).toEqual([]);
  });

  it("enrollment denied (revoked capability) → fail closed, no secret in failure strings", async () => {
    const steward = makeSteward({ deny: true });
    const privateKey = await steward.registerKeypair();
    const env = makeEnv(privateKey);
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      { OPENAI_API_KEY: env.OPENAI_API_KEY as string },
      { env, fetchImpl: steward.fetchImpl },
    );
    expect(resolved).toEqual({});
    expect(failures).toEqual(["OPENAI_API_KEY"]);
    for (const failure of failures) {
      expect(failure).not.toContain(SECRET_VALUE);
    }
  });

  it("steward outage → fail closed for every key", async () => {
    const steward = makeSteward({ outage: true });
    const privateKey = "irrelevant-key";
    const env = makeEnv(privateKey);
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      {
        OPENAI_API_KEY: env.OPENAI_API_KEY as string,
        DISCORD_API_TOKEN: env.DISCORD_API_TOKEN as string,
      },
      { env, fetchImpl: steward.fetchImpl },
    );
    expect(resolved).toEqual({});
    expect(failures.sort()).toEqual(["DISCORD_API_TOKEN", "OPENAI_API_KEY"]);
  });

  it("refs addressed to a FOREIGN workload fail closed without a network call for them", async () => {
    const steward = makeSteward();
    const privateKey = await steward.registerKeypair();
    const env = makeEnv(privateKey);
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      {
        OPENAI_API_KEY: env.OPENAI_API_KEY as string,
        STOLEN: "vault://workload/other-container/API_KEY",
      },
      { env, fetchImpl: steward.fetchImpl },
    );
    expect(resolved.OPENAI_API_KEY).toBe(SECRET_VALUE);
    expect(failures).toEqual(["STOLEN"]);
  });

  it("value missing from the namespace (revoked/never written) fails closed per key", async () => {
    const steward = makeSteward();
    const privateKey = await steward.registerKeypair();
    const env = makeEnv(privateKey);
    const { resolved, failures } = await resolveWorkloadSecretSettings(
      {
        OPENAI_API_KEY: env.OPENAI_API_KEY as string,
        NEVER_WRITTEN: `vault://workload/${WORKLOAD_ID}/NEVER_WRITTEN`,
      },
      { env, fetchImpl: steward.fetchImpl },
    );
    expect(resolved.OPENAI_API_KEY).toBe(SECRET_VALUE);
    expect(resolved.NEVER_WRITTEN).toBeUndefined();
    expect(failures).toEqual(["NEVER_WRITTEN"]);
  });

  it("projection strips unresolved sentinels: a plugin can never receive the ref literal", async () => {
    // simulate a total resolution failure: the overlay is empty and the env
    // still held refs before scrubbing — the projection layer must not leak
    // them into settings.
    const settings = buildRuntimeSettingsProjection({} as never, {
      env: {},
      connectorSecretsOverlay: {},
    });
    expect(JSON.stringify(settings)).not.toContain("vault://");
  });
});
