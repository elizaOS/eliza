import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVault,
  generateMasterKey,
  inMemoryMasterKey,
  type RoutingConfig,
  type Vault,
  type VaultEntryMeta,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await handleSecretsInventoryRoute(
        req,
        res,
        url.pathname,
        (req.method ?? "GET").toUpperCase(),
      );
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("secrets-inventory routes", () => {
  let harness: Harness | null;
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    harness = null;
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-inv-routes-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    _resetSharedVaultForTesting(vault);
  });

  afterEach(async () => {
    await harness?.dispose();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    _resetSharedVaultForTesting(null);
  });

  it("GET /api/secrets/inventory returns meta-only entries (no values)", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-NEVERLEAK", {
      sensitive: true,
    });
    await vault.set("EVM_PRIVATE_KEY", "0xNEVERLEAK", { sensitive: true });

    const res = await fetch(`${harness.baseUrl}/api/secrets/inventory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: VaultEntryMeta[] };
    expect(body.entries.length).toBe(2);
    const text = JSON.stringify(body);
    expect(text).not.toContain("NEVERLEAK");
  });

  it("GET /api/secrets/inventory?category=wallet narrows the response", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-NEVERLEAK", {
      sensitive: true,
    });
    await vault.set("EVM_PRIVATE_KEY", "0xNEVERLEAK", { sensitive: true });
    await vault.set("SOLANA_PRIVATE_KEY", "solNEVERLEAK", {
      sensitive: true,
    });

    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory?category=wallet`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: VaultEntryMeta[] };
    expect(body.entries.map((e) => e.key).sort()).toEqual([
      "EVM_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
    ]);
    for (const entry of body.entries) {
      expect(entry.category).toBe("wallet");
    }
  });

  it("GET /api/secrets/inventory?category=garbage 400s", async () => {
    harness = await startHarness();
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory?category=garbage`,
    );
    expect(res.status).toBe(400);
  });

  it("PUT /api/secrets/inventory/:key upserts value + meta", async () => {
    harness = await startHarness();
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/CUSTOM_KEY`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: "the-value",
          label: "My Custom",
          providerId: "custom",
          category: "plugin",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await vault.get("CUSTOM_KEY")).toBe("the-value");
  });

  it("PUT rejects unknown category", async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/api/secrets/inventory/X`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "v", category: "what-is-this" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/secrets/inventory/:key reveals the bare-key value", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-real", { sensitive: true });

    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: string; source: string };
    expect(body.value).toBe("sk-or-real");
    expect(body.source).toBe("bare");
  });

  it("DELETE /api/secrets/inventory/:key drops bare value, profiles, and meta", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-bare", { sensitive: true });
    await vault.set("OPENROUTER_API_KEY.profile.work", "sk-or-work", {
      sensitive: true,
    });
    await vault.set(
      "_meta.OPENROUTER_API_KEY",
      JSON.stringify({
        profiles: [{ id: "work", label: "Work" }],
        activeProfile: "work",
      }),
    );

    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);

    expect(await vault.has("OPENROUTER_API_KEY")).toBe(false);
    expect(await vault.has("OPENROUTER_API_KEY.profile.work")).toBe(false);
    expect(await vault.has("_meta.OPENROUTER_API_KEY")).toBe(false);
  });

  it("rejects reserved keys", async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/api/secrets/inventory/_meta.X`);
    expect(res.status).toBe(400);
  });

  it("POST /:key/profiles creates first profile and auto-activates it", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-bare", { sensitive: true });

    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "work",
          label: "Work",
          value: "sk-or-work",
        }),
      },
    );
    expect(res.status).toBe(200);

    const list = (await (
      await fetch(
        `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      )
    ).json()) as { profiles: Array<{ id: string }>; activeProfile: string };
    expect(list.profiles.map((p) => p.id)).toEqual(["work"]);
    expect(list.activeProfile).toBe("work");
  });

  it("POST /:key/profiles rejects duplicate id", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk", { sensitive: true });
    await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "work", label: "Work", value: "v1" }),
      },
    );
    const dup = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "work", label: "Work", value: "v2" }),
      },
    );
    expect(dup.status).toBe(409);
  });

  it("PATCH /:key/profiles/:id updates label + value", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk", { sensitive: true });
    await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "work", label: "Work", value: "v1" }),
      },
    );
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles/work`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Work Renamed", value: "v2-updated" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await vault.get("OPENROUTER_API_KEY.profile.work")).toBe(
      "v2-updated",
    );
  });

  it("DELETE /:key/profiles/:id removes profile and reassigns active when needed", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk", { sensitive: true });
    await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "a", label: "A", value: "va" }),
      },
    );
    await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "b", label: "B", value: "vb" }),
      },
    );

    // Active was auto-set to "a" (first one). Delete "a" and confirm
    // active flips to "b".
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles/a`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await vault.has("OPENROUTER_API_KEY.profile.a")).toBe(false);

    const list = (await (
      await fetch(
        `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      )
    ).json()) as { profiles: Array<{ id: string }>; activeProfile: string };
    expect(list.profiles.map((p) => p.id)).toEqual(["b"]);
    expect(list.activeProfile).toBe("b");
  });

  it("PUT /:key/active-profile rejects unknown profile id", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk", { sensitive: true });
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/active-profile`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId: "ghost" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("GET /:key revealed value follows active profile when present", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk", { sensitive: true });
    await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY/profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "work", label: "Work", value: "sk-work" }),
      },
    );
    const res = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/OPENROUTER_API_KEY`,
    );
    const body = (await res.json()) as { value: string; source: string };
    expect(body.value).toBe("sk-work");
    expect(body.source).toBe("profile");
  });

  it("POST /api/secrets/inventory/migrate-to-profiles is opt-in and idempotent", async () => {
    harness = await startHarness();
    await vault.set("OPENROUTER_API_KEY", "sk-or-bare", { sensitive: true });

    const first = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/migrate-to-profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "OPENROUTER_API_KEY" }),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { migrated: boolean };
    expect(firstBody.migrated).toBe(true);
    expect(await vault.get("OPENROUTER_API_KEY.profile.default")).toBe(
      "sk-or-bare",
    );

    const second = await fetch(
      `${harness.baseUrl}/api/secrets/inventory/migrate-to-profiles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "OPENROUTER_API_KEY" }),
      },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      migrated: boolean;
      reason?: string;
    };
    expect(secondBody.migrated).toBe(false);
    expect(secondBody.reason).toBe("already-has-profiles");
  });

  it("GET/PUT /api/secrets/routing round-trip", async () => {
    harness = await startHarness();
    const empty = await fetch(`${harness.baseUrl}/api/secrets/routing`);
    const emptyBody = (await empty.json()) as { config: RoutingConfig };
    expect(emptyBody.config.rules).toEqual([]);

    const put = await fetch(`${harness.baseUrl}/api/secrets/routing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          rules: [
            {
              keyPattern: "OPENROUTER_API_KEY",
              scope: { kind: "agent", agentId: "abc" },
              profileId: "work",
            },
          ],
          defaultProfile: "default",
        },
      }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { config: RoutingConfig };
    expect(saved.config.rules).toHaveLength(1);
    expect(saved.config.defaultProfile).toBe("default");
  });
});
