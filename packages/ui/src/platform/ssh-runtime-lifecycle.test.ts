// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { AgentProfile, AgentProfileRegistry } from "../state";
import {
  removeSshRuntime,
  type SshRuntimeLifecycleDependencies,
  type SshRuntimeLifecycleReceipt,
  type SshRuntimeLifecycleReceiptStore,
  setupSshRuntime,
} from "./ssh-runtime-lifecycle";

function store() {
  const receipts = new Map<string, SshRuntimeLifecycleReceipt>();
  const writes: SshRuntimeLifecycleReceipt[] = [];
  const value: SshRuntimeLifecycleReceiptStore = {
    list: () =>
      [...receipts.values()].map((receipt) => structuredClone(receipt)),
    put: (receipt) => {
      writes.push(structuredClone(receipt));
      receipts.set(receipt.operationId, structuredClone(receipt));
    },
    delete: (id) => {
      receipts.delete(id);
    },
  };
  return { receipts, value, writes };
}

function harness() {
  let registry: AgentProfileRegistry = {
    version: 1,
    activeProfileId: "local",
    profiles: [
      {
        id: "local",
        kind: "local",
        label: "This Mac",
        createdAt: "2026-08-22T00:00:00.000Z",
      },
    ],
  };
  const events: string[] = [];
  const dependencies: SshRuntimeLifecycleDependencies = {
    startTunnel: vi.fn(async () => events.push("start")),
    stopTunnel: vi.fn(async () => events.push("stop")),
    storeCredential: vi.fn(async () => events.push("store-credential")),
    deleteCredentialRecord: vi.fn(async () => events.push("delete-credential")),
    addProfile: vi.fn((profile, options) => {
      const created: AgentProfile = {
        ...profile,
        id: options.id,
        createdAt: "2026-08-22T00:00:00.000Z",
      };
      registry = { ...registry, profiles: [...registry.profiles, created] };
      events.push("add-profile");
      return created;
    }),
    removeProfile: vi.fn((id) => {
      registry = {
        ...registry,
        profiles: registry.profiles.filter((profile) => profile.id !== id),
      };
      events.push("remove-profile");
    }),
    loadRegistry: () => registry,
  };
  return { dependencies, events, registry: () => registry };
}

const input = {
  runtimeId: "runtime-1",
  label: "Private VPS",
  target: "eliza@vps.example",
  sshPort: 22,
  remoteApiPort: 2138,
  expectedFingerprint: `SHA256:${"A".repeat(43)}`,
  identityFile: "/Users/test/.ssh/id_ed25519",
  credentialRef: "runtime-1",
  accessToken: "agent-token",
};

describe("SSH runtime lifecycle", () => {
  it("commits setup without persisting a key path, token, or fingerprint in its receipt", async () => {
    const state = store();
    const { dependencies, events, registry } = harness();
    const profile = await setupSshRuntime(input, dependencies, state.value);
    expect(profile.id).toBe("runtime-1");
    expect(events).toEqual(["store-credential", "start", "add-profile"]);
    expect(registry().activeProfileId).toBe("local");
    expect(state.receipts.size).toBe(0);
    expect(JSON.stringify(state.writes)).not.toContain("agent-token");
    expect(JSON.stringify(state.writes)).not.toContain("id_ed25519");
    expect(JSON.stringify(state.writes)).not.toContain("SHA256:");
  });

  it("retains retryable cleanup evidence when tunnel start and credential deletion fail", async () => {
    const state = store();
    const { dependencies } = harness();
    dependencies.startTunnel = vi.fn(async () => {
      throw new Error("VPS unavailable");
    });
    dependencies.deleteCredentialRecord = vi.fn(async () => {
      throw new Error("secure store unavailable");
    });
    await expect(
      setupSshRuntime(input, dependencies, state.value),
    ).rejects.toMatchObject({
      code: "SSH_RUNTIME_LIFECYCLE_INCOMPLETE",
      pendingSteps: ["credential-delete"],
    });
    const [receipt] = [...state.receipts.values()];
    expect(receipt?.pending).toEqual({
      stopTunnel: false,
      deleteCredential: true,
      removeProfile: false,
    });
  });

  it("refuses removal of the active SSH runtime before any destructive step", async () => {
    const state = store();
    const { dependencies, registry } = harness();
    const profile = await setupSshRuntime(input, dependencies, state.value);
    const current = registry();
    current.activeProfileId = profile.id;
    await expect(
      removeSshRuntime(profile, dependencies, state.value),
    ).rejects.toThrow(/switch away/i);
    expect(dependencies.stopTunnel).toHaveBeenCalledTimes(0);
  });
});
