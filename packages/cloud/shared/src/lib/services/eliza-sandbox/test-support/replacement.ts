/** Provides explicit replacement fixtures for deterministic sandbox orchestration tests. Importing this module installs no hooks, spies, or lifecycle simulation. */

import { expect } from "bun:test";
import type { AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../../db/repositories/agent-sandboxes";
import { type SandboxHandle, type SandboxProvider } from "../../sandbox-provider-types";
import { sandboxTransactions } from "./database.js";
import { replacementAttemptCounter, replacementAwareProvider } from "./provider.js";

export type ReplacementExpectation = {
  status: AgentSandbox["status"];
  environmentRevision: number;
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
};

export type TestReplacementLocator = {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  replacementAttemptId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
  vpnNodeName: string | null;
  previousVpnNodeId: string | null;
  vpnRegistrationStartedAt: Date | null;
  allocationCounted: boolean;
  createdAt: Date;
};

export type ReplacementLifecycleHarnessState = {
  candidate: TestReplacementLocator | null;
  expected: ReplacementExpectation | null;
};

export type ReplacementLifecycleHarnessService = {
  persistReplacementCleanupStage(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expected: ReplacementExpectation,
    stage: "intent" | "created" | "vpn",
  ): Promise<void>;
  transferReplacementToPrimary(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expectedEnvironmentRevision: number,
    updateData: Partial<AgentSandbox>,
  ): Promise<AgentSandbox>;
  retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<boolean>;
  getReplacementCleanupLocator(rec: AgentSandbox): TestReplacementLocator | null;
  host: { getProvider(): Promise<SandboxProvider> };
};

export const replacementLifecycleHarnessState = new WeakMap<
  object,
  ReplacementLifecycleHarnessState
>();

export function replacementLocatorFromTestHandle(
  handle: SandboxHandle,
  createdAt = new Date("2026-07-23T00:00:00.000Z"),
): TestReplacementLocator {
  const metadata = handle.metadata ?? {};
  const nodeId = typeof metadata.nodeId === "string" ? metadata.nodeId : "";
  const containerName = typeof metadata.containerName === "string" ? metadata.containerName : "";
  const replacementAttemptId =
    typeof metadata.replacementAttemptId === "string" ? metadata.replacementAttemptId : null;
  const vpnRegistrationStartedAt =
    typeof metadata.vpnRegistrationStartedAt === "string"
      ? new Date(metadata.vpnRegistrationStartedAt)
      : null;
  return {
    sandboxId: handle.sandboxId,
    nodeId,
    containerName,
    replacementAttemptId,
    containerId: typeof metadata.containerId === "string" ? metadata.containerId : null,
    vpnNodeId: typeof metadata.vpnNodeId === "string" ? metadata.vpnNodeId : null,
    vpnNodeName: typeof metadata.vpnNodeName === "string" ? metadata.vpnNodeName : null,
    previousVpnNodeId:
      typeof metadata.previousVpnNodeId === "string" ? metadata.previousVpnNodeId : null,
    vpnRegistrationStartedAt,
    allocationCounted: metadata.allocationCounted === true,
    createdAt,
  };
}

export function expectSameReplacement(
  existing: TestReplacementLocator,
  incoming: TestReplacementLocator,
): void {
  expect(incoming).toMatchObject({
    sandboxId: existing.sandboxId,
    nodeId: existing.nodeId,
    containerName: existing.containerName,
    replacementAttemptId: existing.replacementAttemptId,
    vpnNodeName: existing.vpnNodeName,
    previousVpnNodeId: existing.previousVpnNodeId,
    allocationCounted: existing.allocationCounted,
  });
  expect(incoming.vpnRegistrationStartedAt?.getTime() ?? null).toBe(
    existing.vpnRegistrationStartedAt?.getTime() ?? null,
  );
}

export async function installReplacementLifecycleSimulation(): Promise<() => void> {
  const { SandboxReplacementCleanup } = await import("../lifecycle/replacement-cleanup.js");
  const prototype =
    SandboxReplacementCleanup.prototype as unknown as ReplacementLifecycleHarnessService;
  const originals = {
    persistReplacementCleanupStage: prototype.persistReplacementCleanupStage,
    transferReplacementToPrimary: prototype.transferReplacementToPrimary,
    retirePersistedReplacementCleanup: prototype.retirePersistedReplacementCleanup,
    getReplacementCleanupLocator: prototype.getReplacementCleanupLocator,
  };

  prototype.persistReplacementCleanupStage = async function (
    _agentId,
    _orgId,
    handle,
    expected,
    stage,
  ): Promise<void> {
    const state = replacementLifecycleHarnessState.get(this) ?? {
      candidate: null,
      expected: null,
    };
    const incoming = replacementLocatorFromTestHandle(handle, state.candidate?.createdAt);
    if (!incoming.nodeId || !incoming.containerName || !incoming.replacementAttemptId) {
      throw new Error("Replacement fixture has incomplete durable placement identity");
    }
    if (stage === "intent") {
      expect(incoming.containerId).toBeNull();
      expect(incoming.vpnNodeId).toBeNull();
      expect(incoming.allocationCounted).toBe(true);
      if (state.candidate) expectSameReplacement(state.candidate, incoming);
      state.candidate = incoming;
      state.expected = expected;
      sandboxTransactions.outcome = null;
    } else {
      if (!state.candidate) {
        throw new Error("Replacement fixture enrichment arrived before durable intent");
      }
      expectSameReplacement(state.candidate, incoming);
      if (stage === "created") {
        expect(incoming.containerId).not.toBeNull();
        state.candidate.containerId = incoming.containerId;
      } else {
        expect(incoming.vpnNodeId).not.toBeNull();
        state.candidate.containerId = incoming.containerId;
        state.candidate.vpnNodeId = incoming.vpnNodeId;
      }
    }
    replacementLifecycleHarnessState.set(this, state);
  };

  prototype.transferReplacementToPrimary = async function (
    agentId,
    _orgId,
    handle,
    expectedEnvironmentRevision,
    updateData,
  ): Promise<AgentSandbox> {
    const state = replacementLifecycleHarnessState.get(this) ?? {
      candidate: null,
      expected: null,
    };
    let incoming = replacementLocatorFromTestHandle(handle, state.candidate?.createdAt);
    if (state.candidate) {
      expectSameReplacement(state.candidate, incoming);
      expect(incoming.containerId).toBe(state.candidate.containerId);
      expect(incoming.vpnNodeId).toBe(state.candidate.vpnNodeId);
      expect(state.expected?.environmentRevision).toBe(expectedEnvironmentRevision);
    } else if (handle.metadata?.provider === "docker") {
      // Provision tests whose provider fake intentionally omits Docker's remote
      // internals still enter adoption with the exact returned handle. Model
      // the provider's already-covered durable intent+created result here;
      // retry-adoption fixtures likewise begin with this handle on the row.
      expect(handle.sandboxId).toBe(updateData.sandbox_id);
      replacementAttemptCounter.value += 1;
      incoming = {
        ...incoming,
        replacementAttemptId: `00000000-0000-4000-8000-${replacementAttemptCounter.value
          .toString()
          .padStart(12, "0")}`,
        containerId: `container-${handle.sandboxId}`,
        allocationCounted: true,
      };
      state.candidate = incoming;
      state.expected = {
        status: "provisioning",
        environmentRevision: expectedEnvironmentRevision,
        sandboxId: null,
        nodeId: null,
        containerName: null,
      };
      replacementLifecycleHarnessState.set(this, state);
    }
    replacementAwareProvider(await this.host.getProvider());
    const adopted = await agentSandboxesRepository.update(agentId, updateData);
    if (!adopted) throw new Error("Replacement adoption CAS failed");
    state.candidate = null;
    state.expected = null;
    replacementLifecycleHarnessState.set(this, state);
    return adopted;
  };

  prototype.getReplacementCleanupLocator = function (
    rec: AgentSandbox,
  ): TestReplacementLocator | null {
    const persisted = originals.getReplacementCleanupLocator.call(this, rec);
    if (persisted) return persisted;
    return replacementLifecycleHarnessState.get(this)?.candidate ?? null;
  };

  prototype.retirePersistedReplacementCleanup = async function (): Promise<boolean> {
    const state = replacementLifecycleHarnessState.get(this);
    if (!state?.candidate) return false;
    const provider = await this.host.getProvider();
    const cutoverCommitted =
      sandboxTransactions.outcome?.status === "resolved" &&
      sandboxTransactions.outcome.value === true &&
      state.expected?.status === "running";
    const locator = cutoverCommitted
      ? {
          ...state.candidate,
          sandboxId: state.expected?.sandboxId ?? "",
          nodeId: state.expected?.nodeId ?? "",
          containerName: state.expected?.containerName ?? "",
          replacementAttemptId: null,
          containerId: null,
          vpnNodeId: state.candidate.previousVpnNodeId,
          vpnNodeName: null,
          previousVpnNodeId: null,
          vpnRegistrationStartedAt: null,
          allocationCounted: true,
        }
      : state.candidate;
    if (!locator.sandboxId || !locator.nodeId || !locator.containerName) {
      throw new Error("Replacement fixture has no cleanup identity");
    }
    if (provider.stopOnSpecificNodeForReplacement) {
      await provider.stopOnSpecificNodeForReplacement(
        locator.nodeId,
        locator.containerName,
        locator.vpnNodeId,
        {
          replacementAttemptId: locator.replacementAttemptId,
          containerId: locator.containerId,
          vpnNodeName: locator.vpnNodeName,
          previousVpnNodeId: locator.previousVpnNodeId,
          vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt?.toISOString() ?? null,
          allocationCounted: locator.allocationCounted,
        },
      );
    } else if (provider.stopForReplacement) {
      await provider.stopForReplacement(locator.sandboxId);
    } else {
      throw new Error("Sandbox provider cannot prove failed provision absent");
    }
    state.candidate = null;
    state.expected = null;
    replacementLifecycleHarnessState.set(this, state);
    return true;
  };

  return () => {
    prototype.persistReplacementCleanupStage = originals.persistReplacementCleanupStage;
    prototype.transferReplacementToPrimary = originals.transferReplacementToPrimary;
    prototype.retirePersistedReplacementCleanup = originals.retirePersistedReplacementCleanup;
    prototype.getReplacementCleanupLocator = originals.getReplacementCleanupLocator;
  };
}
