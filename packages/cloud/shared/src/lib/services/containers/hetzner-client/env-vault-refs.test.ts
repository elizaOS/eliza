// Unit surface for provision-time env sealing: ref format parity with the
// agent-side vault-bridge sentinel, secret/non-secret partitioning, steward
// upsert semantics (create → 409 → rotate), and the fail-closed error policy
// (a vault failure throws; it never degrades to plaintext passthrough).
import { describe, expect, test } from "bun:test";
import {
  buildContainerEnvVaultKey,
  formatVaultRef,
  isVaultRef,
  parseVaultRef,
  sealContainerEnvToVault,
  VAULT_REF_PREFIX,
  type VaultRefsStewardConfig,
} from "./env-vault-refs";
import { HetznerClientError } from "./types";

// ── In-memory steward fake speaking the /secrets wire contract ──────────────

interface FakeStewardState {
  secrets: Map<string, { id: string; value: string }>;
  requests: Array<{ method: string; path: string }>;
}

function makeFakeSteward(
  state: FakeStewardState,
  opts: { failCreate?: boolean; failRotate?: boolean } = {},
): VaultRefsStewardConfig {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.requests.push({ method, path: url.pathname });

    if (method === "POST" && url.pathname === "/secrets") {
      if (opts.failCreate) return new Response("boom", { status: 500 });
      const body = JSON.parse(String(init?.body)) as { name: string; value: string };
      if (state.secrets.has(body.name)) {
        return Response.json({ ok: false, error: "duplicate" }, { status: 409 });
      }
      const id = `sec-${state.secrets.size + 1}`;
      state.secrets.set(body.name, { id, value: body.value });
      return Response.json({ ok: true }, { status: 201 });
    }
    if (method === "GET" && url.pathname === "/secrets") {
      const data = [...state.secrets.entries()].map(([name, row]) => ({ id: row.id, name }));
      return Response.json({ ok: true, data });
    }
    const putMatch = /^\/secrets\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && putMatch) {
      if (opts.failRotate) return new Response("boom", { status: 500 });
      const body = JSON.parse(String(init?.body)) as { value: string };
      for (const row of state.secrets.values()) {
        if (row.id === decodeURIComponent(putMatch[1] as string)) {
          row.value = body.value;
          return Response.json({ ok: true });
        }
      }
      return Response.json({ ok: false }, { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { baseUrl: "https://steward.test", tenantId: "elizacloud", apiKey: "k", fetchImpl };
}

// ── Ref format parity (pinned to vault-bridge's sentinel scheme) ────────────

describe("vault:// ref format (vault-bridge parity)", () => {
  test("prefix is exactly the vault-bridge sentinel", () => {
    expect(VAULT_REF_PREFIX).toBe("vault://");
  });

  test("format → guard → parse round-trips", () => {
    const key = buildContainerEnvVaultKey("org1", "proj", "OPENAI_API_KEY");
    const ref = formatVaultRef(key);
    expect(ref).toBe(`vault://${key}`);
    expect(isVaultRef(ref)).toBe(true);
    expect(parseVaultRef(ref)).toBe(key);
  });

  test("guard rejects non-refs and the bare prefix", () => {
    expect(isVaultRef("sk-live-abc")).toBe(false);
    expect(isVaultRef("vault://")).toBe(false);
    expect(isVaultRef(undefined)).toBe(false);
    expect(parseVaultRef("plain")).toBeNull();
  });
});

// ── Sealing behavior ────────────────────────────────────────────────────────

describe("sealContainerEnvToVault", () => {
  test("secret values move to the vault; env carries only refs; non-secrets pass through", async () => {
    const state: FakeStewardState = { secrets: new Map(), requests: [] };
    const result = await sealContainerEnvToVault(
      {
        organizationId: "org1",
        projectName: "proj",
        environmentVars: {
          OPENAI_API_KEY: "sk-live-supersecret",
          DISCORD_BOT_TOKEN: "discord-supersecret",
          NODE_ENV: "production",
          LOG_LEVEL: "debug",
        },
      },
      makeFakeSteward(state),
    );

    // Refs, not values, in the sealed env.
    const openaiKey = buildContainerEnvVaultKey("org1", "proj", "OPENAI_API_KEY");
    const discordKey = buildContainerEnvVaultKey("org1", "proj", "DISCORD_BOT_TOKEN");
    expect(result.env.OPENAI_API_KEY).toBe(`vault://${openaiKey}`);
    expect(result.env.DISCORD_BOT_TOKEN).toBe(`vault://${discordKey}`);
    // Non-secret config untouched.
    expect(result.env.NODE_ENV).toBe("production");
    expect(result.env.LOG_LEVEL).toBe("debug");
    expect(result.sealedKeys.sort()).toEqual(["DISCORD_BOT_TOKEN", "OPENAI_API_KEY"]);

    // Bidirectional proof: no secret value anywhere in the sealed env…
    const serialized = JSON.stringify(result.env);
    expect(serialized).not.toContain("sk-live-supersecret");
    expect(serialized).not.toContain("discord-supersecret");
    // …and the vault DOES hold them, under the ref keys.
    expect(state.secrets.get(openaiKey)?.value).toBe("sk-live-supersecret");
    expect(state.secrets.get(discordKey)?.value).toBe("discord-supersecret");
  });

  test("idempotent: values that are already refs are NOT re-sealed", async () => {
    const state: FakeStewardState = { secrets: new Map(), requests: [] };
    const ref = formatVaultRef(buildContainerEnvVaultKey("org1", "proj", "OPENAI_API_KEY"));
    const result = await sealContainerEnvToVault(
      { organizationId: "org1", projectName: "proj", environmentVars: { OPENAI_API_KEY: ref } },
      makeFakeSteward(state),
    );
    expect(result.env.OPENAI_API_KEY).toBe(ref);
    expect(result.sealedKeys).toEqual([]);
    expect(state.requests).toEqual([]); // no vault traffic at all
  });

  test("re-provision rotates the existing secret via 409 → list → PUT", async () => {
    const state: FakeStewardState = { secrets: new Map(), requests: [] };
    const config = makeFakeSteward(state);
    const params = {
      organizationId: "org1",
      projectName: "proj",
      environmentVars: { OPENAI_API_KEY: "sk-old" },
    };
    await sealContainerEnvToVault(params, config);
    await sealContainerEnvToVault(
      { ...params, environmentVars: { OPENAI_API_KEY: "sk-new" } },
      config,
    );
    const key = buildContainerEnvVaultKey("org1", "proj", "OPENAI_API_KEY");
    expect(state.secrets.get(key)?.value).toBe("sk-new");
    expect(state.secrets.size).toBe(1); // rotated in place, no orphan rows
  });

  test("FAIL CLOSED: a vault write failure throws and never returns plaintext", async () => {
    const state: FakeStewardState = { secrets: new Map(), requests: [] };
    await expect(
      sealContainerEnvToVault(
        {
          organizationId: "org1",
          projectName: "proj",
          environmentVars: { OPENAI_API_KEY: "sk-live-supersecret" },
        },
        makeFakeSteward(state, { failCreate: true }),
      ),
    ).rejects.toMatchObject({ code: "container_create_failed" });
  });

  test("FAIL CLOSED on rotate failure too", async () => {
    const state: FakeStewardState = { secrets: new Map(), requests: [] };
    const okConfig = makeFakeSteward(state);
    await sealContainerEnvToVault(
      { organizationId: "org1", projectName: "proj", environmentVars: { API_KEY: "v1" } },
      okConfig,
    );
    await expect(
      sealContainerEnvToVault(
        { organizationId: "org1", projectName: "proj", environmentVars: { API_KEY: "v2" } },
        makeFakeSteward(state, { failRotate: true }),
      ),
    ).rejects.toBeInstanceOf(HetznerClientError);
  });
});
