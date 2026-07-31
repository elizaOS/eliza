// Unit proof for the workload-contract sealing module (#17432). The Steward
// fetch here is a MINIMAL wire double for unit-level partitioning/fail-closed
// checks only — the HEADLINE cross-repo evidence runs against the REAL
// Steward API in workload-cross-repo.e2e.test.ts (no invented routes there).
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildWorkloadRefKey,
  deriveWorkloadId,
  formatVaultRef,
  isVaultRef,
  parseVaultRef,
  revokeWorkloadForDeletedContainer,
  sealContainerEnvToWorkload,
  WORKLOAD_CAPABILITY_ENV_KEYS,
} from "./workload-env-refs";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeSteward(behavior?: {
  failOn?: (method: string, path: string) => boolean;
  reject?: boolean;
}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (behavior?.reject) throw new Error("ECONNREFUSED");
    if (behavior?.failOn?.(method, url.pathname)) {
      return Response.json({ ok: false, error: "denied" }, { status: 403 });
    }
    return Response.json({ ok: true, data: {} });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const PARAMS = {
  organizationId: "org-1",
  projectName: "proj-a",
  environmentVars: {
    OPENAI_API_KEY: "sk-live-supersecret",
    DISCORD_TOKEN: "discord-secret",
    NODE_ENV: "production",
    PORT: "3000",
  },
};

function config(fetchImpl: typeof fetch) {
  return { baseUrl: "https://steward.test", tenantId: "t1", apiKey: "k", fetchImpl };
}

describe("ref format (pinned to vault-bridge)", () => {
  test("format/isVaultRef/parseVaultRef round-trip; prefix is vault://", () => {
    const key = buildWorkloadRefKey("wl-abc", "OPENAI_API_KEY");
    const ref = formatVaultRef(key);
    expect(ref).toBe("vault://workload/wl-abc/OPENAI_API_KEY");
    expect(isVaultRef(ref)).toBe(true);
    expect(parseVaultRef(ref)).toBe(key);
    expect(isVaultRef("vault://")).toBe(false);
    expect(isVaultRef("workload/x/y")).toBe(false);
  });

  test("workload id is deterministic per org/project and fits the Steward id contract", () => {
    const a = deriveWorkloadId("org-1", "proj-a");
    expect(deriveWorkloadId("org-1", "proj-a")).toBe(a);
    expect(deriveWorkloadId("org-1", "proj-b")).not.toBe(a);
    expect(deriveWorkloadId("org-2", "proj-a")).not.toBe(a);
    // arbitrary inputs still produce contract-conformant ids
    const weird = deriveWorkloadId("Org With Spaces/슬래시", "проект!@#");
    expect(weird).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
  });
});

describe("sealing partitioning", () => {
  test("secrets become refs + capability; non-secrets pass through; steward got register + one PUT per secret", async () => {
    const { calls, fetchImpl } = makeSteward();
    const sealed = await sealContainerEnvToWorkload(PARAMS, config(fetchImpl));

    const wl = deriveWorkloadId("org-1", "proj-a");
    expect(sealed.workloadId).toBe(wl);
    expect(sealed.sealedKeys.sort()).toEqual(["DISCORD_TOKEN", "OPENAI_API_KEY"]);
    // refs, not values
    expect(sealed.env.OPENAI_API_KEY).toBe(`vault://workload/${wl}/OPENAI_API_KEY`);
    expect(sealed.env.DISCORD_TOKEN).toBe(`vault://workload/${wl}/DISCORD_TOKEN`);
    // non-secret passthrough
    expect(sealed.env.NODE_ENV).toBe("production");
    expect(sealed.env.PORT).toBe("3000");
    // capability triplet present; the private key is NOT the secret values
    expect(sealed.env.STEWARD_API_URL).toBe("https://steward.test");
    expect(sealed.env.STEWARD_WORKLOAD_ID).toBe(wl);
    expect(sealed.env.STEWARD_WORKLOAD_KEY?.length).toBeGreaterThan(100);
    // NO secret value anywhere in the sealed env
    const serialized = JSON.stringify(sealed.env);
    expect(serialized).not.toContain("sk-live-supersecret");
    expect(serialized).not.toContain("discord-secret");

    // wire shape: register first, then per-secret PUTs with the value
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/workload-secrets/workloads" });
    const registerBody = (calls[0]?.body ?? {}) as { publicKey?: string };
    expect(registerBody.publicKey?.length ?? 0).toBeGreaterThan(80);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path).sort()).toEqual([
      `/v1/workload-secrets/workloads/${wl}/secrets/DISCORD_TOKEN`,
      `/v1/workload-secrets/workloads/${wl}/secrets/OPENAI_API_KEY`,
    ]);
    expect(puts.find((c) => c.path.endsWith("OPENAI_API_KEY"))?.body).toEqual({
      value: "sk-live-supersecret",
    });
  });

  test("already-ref values pass through without re-write; capability keys in input are dropped (never sealed)", async () => {
    const { calls, fetchImpl } = makeSteward();
    const wl = deriveWorkloadId("org-1", "proj-a");
    const sealed = await sealContainerEnvToWorkload(
      {
        ...PARAMS,
        environmentVars: {
          OPENAI_API_KEY: `vault://workload/${wl}/OPENAI_API_KEY`,
          NODE_ENV: "production",
          // stale capability from a previous seal (echoed back by a
          // read-modify-write PATCH): replaced, never treated as a secret
          STEWARD_WORKLOAD_KEY: "stale-key-material",
        },
      },
      config(fetchImpl),
    );
    // ref passthrough, no value PUT for it
    expect(sealed.env.OPENAI_API_KEY).toBe(`vault://workload/${wl}/OPENAI_API_KEY`);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    // capability regenerated, stale material gone
    expect(sealed.env.STEWARD_WORKLOAD_KEY).not.toBe("stale-key-material");
    expect(JSON.stringify(sealed.env)).not.toContain("stale-key-material");
    // registration still ran (capability rotation on every seal)
    expect(calls[0]?.path).toBe("/v1/workload-secrets/workloads");
  });

  test("every seal registers a FRESH keypair (capability rotation)", async () => {
    const { calls, fetchImpl } = makeSteward();
    await sealContainerEnvToWorkload(PARAMS, config(fetchImpl));
    await sealContainerEnvToWorkload(PARAMS, config(fetchImpl));
    const registers = calls.filter((c) => c.path === "/v1/workload-secrets/workloads");
    expect(registers).toHaveLength(2);
    const [k1, k2] = registers.map((c) => (c.body as { publicKey: string }).publicKey);
    expect(k1).not.toBe(k2);
  });
});

describe("fail-closed", () => {
  test("register denial aborts before any secret leaves the process", async () => {
    const { calls, fetchImpl } = makeSteward({
      failOn: (m, p) => m === "POST" && p === "/v1/workload-secrets/workloads",
    });
    await expect(sealContainerEnvToWorkload(PARAMS, config(fetchImpl))).rejects.toMatchObject({
      code: "container_create_failed",
    });
    // no value was ever transmitted
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  test("secret write denial aborts the seal", async () => {
    const { fetchImpl } = makeSteward({ failOn: (m) => m === "PUT" });
    await expect(sealContainerEnvToWorkload(PARAMS, config(fetchImpl))).rejects.toMatchObject({
      code: "container_create_failed",
    });
  });

  test("steward unreachable (outage) aborts, message carries no secret value", async () => {
    const { fetchImpl } = makeSteward({ reject: true });
    let caught: unknown;
    try {
      await sealContainerEnvToWorkload(PARAMS, config(fetchImpl));
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "container_create_failed" });
    const message = caught instanceof Error ? caught.message : "";
    expect(message).not.toContain("sk-live-supersecret");
    expect(message).not.toContain("discord-secret");
  });
});

describe("revocation on container delete", () => {
  test("stored env with a workload id triggers DELETE /workloads/:id", async () => {
    const { calls, fetchImpl } = makeSteward();
    await revokeWorkloadForDeletedContainer(
      { STEWARD_WORKLOAD_ID: "wl-dead", OPENAI_API_KEY: "vault://workload/wl-dead/OPENAI_API_KEY" },
      () => config(fetchImpl),
    );
    expect(calls).toEqual([
      { method: "DELETE", path: "/v1/workload-secrets/workloads/wl-dead", body: undefined },
    ]);
  });

  test("no workload id in the stored env → no-op (legacy containers)", async () => {
    const { calls, fetchImpl } = makeSteward();
    await revokeWorkloadForDeletedContainer({ OPENAI_API_KEY: "plain" }, () => config(fetchImpl));
    await revokeWorkloadForDeletedContainer(null, () => config(fetchImpl));
    expect(calls).toEqual([]);
  });

  test("revocation failure is contained (teardown must not be blocked)", async () => {
    const { fetchImpl } = makeSteward({ reject: true });
    // must NOT throw
    await revokeWorkloadForDeletedContainer({ STEWARD_WORKLOAD_ID: "wl-dead" }, () =>
      config(fetchImpl),
    );
  });
});

describe("constants", () => {
  test("capability env keys are the documented triplet", () => {
    expect([...WORKLOAD_CAPABILITY_ENV_KEYS]).toEqual([
      "STEWARD_API_URL",
      "STEWARD_WORKLOAD_ID",
      "STEWARD_WORKLOAD_KEY",
    ]);
  });
});

afterEach(() => {
  delete process.env.CONTAINERS_ENV_VAULT_REFS;
});
