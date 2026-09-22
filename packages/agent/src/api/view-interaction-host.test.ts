/** Exercises real runtime/installation ownership, host shutdown, role-checked claims, and renderer reply correlation; no network or model inference. */
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  beginViewInstallation,
  commitViewInstallation,
  revokeViewInstallation,
} from "./view-installations.ts";
import {
  closeViewInteractionHost,
  type ViewInteractionHost,
  viewInteractionHost,
} from "./view-interaction-host.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

function installed(roleGate?: ViewRegistryEntry["roleGate"]) {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Shared ID" }),
    enableAutonomy: false,
  });
  const entry: ViewRegistryEntry = {
    id: "notes",
    roleGate,
    label: "Notes",
    pluginName: "notes",
    viewType: "gui",
    hasHeroImage: false,
    available: true,
    loadedAt: 0,
    platform: "web",
  };
  const installation = beginViewInstallation(runtime, "notes");
  const [published] = commitViewInstallation(runtime, installation, [entry]);
  return { runtime, entry: published, installation };
}

function claimReply(
  host: ViewInteractionHost,
  clientId: string,
  entry: ViewRegistryEntry,
  requestId: string,
) {
  const binding = {
    requestId,
    viewId: entry.id,
    viewType: entry.viewType,
    installationId: entry.installationId!,
  };
  const claimId = host.claim(clientId, binding, []);
  expect(claimId).toEqual(expect.any(String));
  return { ...binding, claimId: claimId!, success: true };
}

describe("view interaction host authority", () => {
  it("runtime stop cancels its pending requests across hosts without stopping a peer runtime", async () => {
    const a = installed();
    const b = installed();
    const firstKey = {};
    const secondKey = {};
    const first = viewInteractionHost(a.runtime, firstKey);
    const second = viewInteractionHost(a.runtime, secondKey);
    const peer = viewInteractionHost(b.runtime, firstKey);
    const rejected = [first, second].map((host, index) =>
      expect(
        host.waitFor(`stop-${index}`, "client", a.entry, 60_000),
      ).rejects.toMatchObject({
        code: "VIEW_HOST_CLOSED",
      }),
    );
    const surviving = peer.waitFor("peer", "client", b.entry, 60_000);
    try {
      const stopped = a.runtime.stop();
      await Promise.all(rejected);
      expect(() => viewInteractionHost(a.runtime, {})).toThrowError(
        expect.objectContaining({ code: "VIEW_HOST_CLOSED" }),
      );
      peer.resolve("client", claimReply(peer, "client", b.entry, "peer"));
      await expect(surviving).resolves.toMatchObject({ success: true });
      await stopped;
    } finally {
      closeViewInteractionHost(firstKey);
      closeViewInteractionHost(secondKey);
      await b.runtime.stop();
    }
  });

  it("does not revive retained authority when a replacement reuses the old entry object", async () => {
    const { runtime, entry } = installed();
    const key = {};
    const host = viewInteractionHost(runtime, key);
    const pending = host.waitFor("old", "client", entry, 1000);
    const closed = expect(pending).rejects.toMatchObject({
      code: "VIEW_HOST_CLOSED",
    });
    const reply = claimReply(host, "client", entry, "old");
    const next = beginViewInstallation(runtime, "notes");
    commitViewInstallation(runtime, next, [entry]);
    host.resolve("client", reply);
    closeViewInteractionHost(key);
    await closed;
  });

  it("requires the issuing host and client even when runtimes have identical agent IDs", async () => {
    const a = installed();
    const b = installed();
    expect(a.runtime.agentId).toBe(b.runtime.agentId);
    const aKey = {};
    const bKey = {};
    const first = viewInteractionHost(a.runtime, aKey);
    const second = viewInteractionHost(b.runtime, bKey);
    const result = { requestId: "same-request", success: true, result: "A" };
    let settled = false;
    const pending = first.waitFor(result.requestId, "client-a", a.entry, 1000);
    void pending.then(() => {
      settled = true;
    });
    const reply = {
      ...claimReply(first, "client-a", a.entry, result.requestId),
      result: "A",
    };
    second.resolve("client-a", reply);
    first.resolve("client-b", reply);
    await Promise.resolve();
    expect(settled).toBe(false);
    first.resolve("client-a", reply);
    await expect(pending).resolves.toEqual(result);
    closeViewInteractionHost(aKey);
    closeViewInteractionHost(bKey);
  });

  it("closes only the stopped host, including when both serve the same runtime", async () => {
    const { runtime, entry } = installed();
    const aKey = {};
    const bKey = {};
    const first = viewInteractionHost(runtime, aKey);
    const second = viewInteractionHost(runtime, bKey);
    const a = first.waitFor("a", "client", entry, 1000);
    const b = second.waitFor("b", "client", entry, 1000);
    const closed = expect(a).rejects.toMatchObject({
      code: "VIEW_HOST_CLOSED",
    });
    closeViewInteractionHost(aKey);
    await closed;
    expect(() => viewInteractionHost(runtime, aKey)).toThrowError(
      expect.objectContaining({ code: "VIEW_HOST_CLOSED" }),
    );
    second.resolve("client", claimReply(second, "client", entry, "b"));
    await expect(b).resolves.toMatchObject({ success: true });
    closeViewInteractionHost(bKey);
  });

  it("does not accept a retired installation's late renderer result", async () => {
    const { runtime, entry, installation } = installed();
    const key = {};
    const host = viewInteractionHost(runtime, key);
    const pending = host.waitFor("old", "client", entry, 1000);
    const closed = expect(pending).rejects.toMatchObject({
      code: "VIEW_HOST_CLOSED",
    });
    const reply = claimReply(host, "client", entry, "old");
    revokeViewInstallation(runtime, installation);
    host.resolve("client", reply);
    closeViewInteractionHost(key);
    await closed;
  });
  it("grants one execution claim and binds settlement to that renderer's installation", async () => {
    const { runtime, entry, installation } = installed();
    const key = {};
    const host = viewInteractionHost(runtime, key);
    const binding = {
      requestId: "claim",
      viewId: entry.id,
      viewType: entry.viewType,
      installationId: entry.installationId!,
    };
    const pending = host.waitFor(binding.requestId, "client", entry, 1000);
    expect(host.claim("other-client", binding, [])).toBeNull();
    expect(
      host.claim("client", { ...binding, viewType: "tui" }, []),
    ).toBeNull();
    expect(
      host.claim("client", { ...binding, installationId: "retired" }, []),
    ).toBeNull();
    const claimId = host.claim("client", binding, []);
    expect(claimId).toEqual(expect.any(String));
    expect(host.claim("client", binding, [])).toBeNull();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    host.resolve("client", {
      ...binding,
      claimId: "other-executor",
      success: true,
    });
    host.resolve("client", {
      ...binding,
      viewType: "tui",
      claimId: claimId!,
      success: true,
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    host.resolve("client", {
      ...binding,
      claimId: claimId!,
      success: true,
      result: "one effect",
    });
    await expect(pending).resolves.toMatchObject({ result: "one effect" });
    const stale = host.waitFor("stale", "client", entry, 1000);
    const closed = expect(stale).rejects.toMatchObject({
      code: "VIEW_HOST_CLOSED",
    });
    revokeViewInstallation(runtime, installation);
    expect(
      host.claim("client", { ...binding, requestId: "stale" }, []),
    ).toBeNull();
    closeViewInteractionHost(key);
    await closed;
  });
  it("rechecks role access before issuing an execution claim", async () => {
    const { runtime, entry } = installed({ minRole: "OWNER" });
    const key = {};
    const host = viewInteractionHost(runtime, key);
    const binding = {
      requestId: "roles",
      viewId: entry.id,
      viewType: entry.viewType,
      installationId: entry.installationId!,
    };
    const pending = host.waitFor(binding.requestId, "client", entry, 1000);
    expect(host.claim("client", binding, [])).toBeNull();
    const claimId = host.claim("client", binding, ["OWNER"]);
    expect(claimId).toEqual(expect.any(String));
    host.resolve("client", { ...binding, claimId: claimId!, success: true });
    await expect(pending).resolves.toMatchObject({ success: true });
    closeViewInteractionHost(key);
  });
});
