import { AgentRuntime, createCharacter } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import {
  beginViewInstallation,
  commitViewInstallation,
  revokeViewInstallation,
} from "./view-installations.ts";
import { closeViewInteractionHost } from "./view-interaction-host.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import { dispatchViewInteract } from "./views-routes.ts";

function installed(handler: NonNullable<ViewRegistryEntry["serverInteract"]>) {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Dispatch" }),
    enableAutonomy: false,
  });
  const lease = beginViewInstallation(runtime, "notes");
  const [entry] = commitViewInstallation(runtime, lease, [
    {
      id: "notes",
      label: "Notes",
      pluginName: "notes",
      viewType: "gui",
      hasHeroImage: false,
      available: true,
      loadedAt: 0,
      platform: "web",
      serverInteract: handler,
      surface: { capabilities: ["agent-surface"] },
    },
  ]);
  return { runtime, lease, entry, hostKey: {} };
}

it("does not replay through the server when frontend delivery sends then throws", async () => {
  const handler = vi.fn(async () => ({ success: true }));
  const fixture = installed(handler);
  const sent: object[] = [];
  const result = await dispatchViewInteract(
    fixture.entry,
    "notes",
    "agent-click",
    { id: "save" },
    {
      runtime: fixture.runtime,
      hostKey: fixture.hostKey,
      clientId: "client",
      broadcastWsToClientId: (_client, frame) => {
        sent.push(frame);
        throw new Error("socket failed after enqueue");
      },
    },
  );
  expect(sent).toHaveLength(1);
  expect(handler).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: false, failureKind: "unknown" });
  closeViewInteractionHost(fixture.hostKey);
});

it("permits server fallback only for a proven zero delivery count", async () => {
  const handler = vi.fn(async () => ({ success: true }));
  const fixture = installed(handler);
  const result = await dispatchViewInteract(
    fixture.entry,
    "notes",
    "agent-click",
    { id: "save" },
    {
      runtime: fixture.runtime,
      hostKey: fixture.hostKey,
      clientId: "client",
      broadcastWsToClientId: () => 0,
    },
  );
  expect(handler).toHaveBeenCalledTimes(1);
  expect(result.success).toBe(true);
  closeViewInteractionHost(fixture.hostKey);
});

it("does not certify a replaced installation's completion after its handler yielded", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = vi.fn(async () => {
    await barrier;
    return { success: true };
  });
  const fixture = installed(handler);
  const pending = dispatchViewInteract(
    fixture.entry,
    "notes",
    "save-note",
    {},
    { runtime: fixture.runtime, hostKey: fixture.hostKey },
  );
  expect(handler).toHaveBeenCalledTimes(1);
  revokeViewInstallation(fixture.runtime, fixture.lease);
  release();
  await expect(pending).resolves.toMatchObject({
    success: false,
    failureKind: "unknown",
  });
  closeViewInteractionHost(fixture.hostKey);
});

it("does not publish a handler's result after its HTTP host closes", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = vi.fn(async () => {
    await barrier;
    return { success: true };
  });
  const fixture = installed(handler);
  const broadcast = vi.fn();
  const pending = dispatchViewInteract(
    fixture.entry,
    "notes",
    "save-note",
    {},
    {
      runtime: fixture.runtime,
      hostKey: fixture.hostKey,
      broadcastWs: broadcast,
    },
  );
  expect(handler).toHaveBeenCalledTimes(1);
  closeViewInteractionHost(fixture.hostKey);
  release();
  await expect(pending).resolves.toMatchObject({
    success: false,
    failureKind: "unknown",
  });
  expect(broadcast).not.toHaveBeenCalled();
});
