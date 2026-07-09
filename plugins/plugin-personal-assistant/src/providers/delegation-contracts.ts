/**
 * Active delegation-contract provider for thread ownership and sender-class
 * SLA policies. The evaluator and repository persist what the owner delegated;
 * this provider makes those rows visible to the planner on the turns where an
 * inbound message might be handled silently, escalated, or turned into a
 * holding-reply draft.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  type LifeOpsDelegationContractRecord,
  renderDelegationContractsProviderText,
} from "../lifeops/delegation-contracts/index.js";
import { LifeOpsRepository } from "../lifeops/repository.js";

const EMPTY: ProviderResult = {
  text: "",
  values: { activeDelegationContractCount: 0 },
  data: { delegationContracts: [] },
};

const CONTRACT_QUERY_LIMIT = 20;

export const delegationContractsProvider: Provider = {
  name: "delegationContracts",
  description:
    "Surfaces active owner delegation contracts for thread ownership, loop-me-if tripwires, and sender-class reply SLAs.",
  descriptionCompressed:
    "Active delegation contracts - thread autonomy, tripwires, reply SLAs.",
  dynamic: true,
  position: 11.5,
  cacheScope: "turn",
  contexts: ["messaging", "email", "tasks", "automation", "general"],
  contextGate: {
    anyOf: ["messaging", "email", "tasks", "automation", "general"],
  },
  roleGate: { minRole: "OWNER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }

    let contracts: LifeOpsDelegationContractRecord[];
    try {
      const repo = new LifeOpsRepository(runtime);
      contracts = (
        await repo.listDelegationContracts(runtime.agentId, {
          statuses: ["active"],
          activeAtIso: new Date().toISOString(),
        })
      ).slice(0, CONTRACT_QUERY_LIMIT);
    } catch (error) {
      // error-policy:J4 explicit user-facing degrade - omit the block when the
      // backing store is unavailable, but report the failure so a broken
      // delegation pipeline does not masquerade as "no active contracts."
      runtime.reportError?.("delegation-contracts.provider", error);
      return EMPTY;
    }

    if (contracts.length === 0) return EMPTY;

    return {
      text: renderDelegationContractsProviderText(contracts),
      values: {
        activeDelegationContractCount: contracts.length,
        activeDelegationContractIds: contracts.map(
          (contract) => contract.contractId,
        ),
      },
      data: { delegationContracts: contracts },
    };
  },
};

export default delegationContractsProvider;
