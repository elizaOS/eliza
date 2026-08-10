/**
 * Product-facing control plane for agent connector bindings. It validates the
 * credential-free binding contract and delegates tenant/ownership checks to an
 * atomic repository operation.
 */
import type { AgentConnectorBinding } from "@elizaos/core";
import {
  AgentConnectorBindingRepositoryError,
  AgentConnectorBindingsRepository,
  type AgentConnectorExecutionBinding,
  agentConnectorBindingsRepository,
  type BindAgentConnectorInput,
} from "../../db/repositories/agent-connector-bindings";
import { ApiError } from "../api/cloud-worker-errors";

export interface CreateAgentConnectorBindingInput {
  organizationId: string;
  agentId: string;
  platformCredentialId: string;
  provider: string;
  role: "OWNER" | "AGENT" | "TEAM";
  purposes?: string[];
  accessGate?: string;
  selectedProducts: string[];
  isDefault?: boolean;
  authorizedByUserId: string;
  ownerBindingId?: string;
  ownerIdentityId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentConnectorBindingsService {
  bind(input: CreateAgentConnectorBindingInput): Promise<AgentConnectorBinding>;
  list(organizationId: string, agentId: string): Promise<AgentConnectorBinding[]>;
  getExecutionBinding(args: {
    organizationId: string;
    agentId: string;
    bindingId: string;
    provider?: string;
  }): Promise<AgentConnectorExecutionBinding>;
  revoke(args: { organizationId: string; agentId: string; bindingId: string }): Promise<void>;
}

interface AgentConnectorBindingsServiceDeps {
  repository: Pick<
    AgentConnectorBindingsRepository,
    "bind" | "list" | "getExecutionBinding" | "revoke"
  >;
}

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ApiError(400, "CONNECTOR_BINDING_INVALID", `${name} is required.`);
  }
  return normalized;
}

function stringList(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values)) {
    throw new ApiError(400, "CONNECTOR_BINDING_INVALID", `${name} must be an array.`);
  }
  return [...new Set(values.map((value) => nonempty(value, `${name} entry`)))];
}

const REPOSITORY_ERROR_STATUS: Record<
  AgentConnectorBindingRepositoryError["code"],
  400 | 403 | 404 | 409
> = {
  AGENT_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  PROVIDER_MISMATCH: 409,
  OWNER_NOT_VERIFIED: 403,
  UNSUPPORTED_PRODUCT: 400,
};

function translateRepositoryError(error: unknown): never {
  if (!(error instanceof AgentConnectorBindingRepositoryError)) throw error;
  throw new ApiError(REPOSITORY_ERROR_STATUS[error.code], error.code, error.message);
}

export function createAgentConnectorBindingsService(
  deps: AgentConnectorBindingsServiceDeps,
): AgentConnectorBindingsService {
  return {
    async bind(input) {
      // Role is validated by the route schema, the TS union, and the DB CHECK
      // constraint; product canonicalization and validation live in the
      // repository so direct repository callers (OAuth storeConnection) share
      // the same UNSUPPORTED_PRODUCT enforcement.
      const provider = nonempty(input.provider, "provider").toLowerCase();
      const repositoryInput: BindAgentConnectorInput = {
        organizationId: nonempty(input.organizationId, "organizationId"),
        agentId: nonempty(input.agentId, "agentId"),
        platformCredentialId: nonempty(input.platformCredentialId, "platformCredentialId"),
        provider,
        role: input.role,
        purposes: stringList(input.purposes ?? ["automation"], "purposes"),
        accessGate: nonempty(input.accessGate ?? "owner_binding", "accessGate"),
        selectedProducts: stringList(input.selectedProducts, "selectedProducts"),
        isDefault: input.isDefault ?? false,
        authorizedByUserId: nonempty(input.authorizedByUserId, "authorizedByUserId"),
        ...(input.ownerBindingId ? { ownerBindingId: input.ownerBindingId } : {}),
        ...(input.ownerIdentityId ? { ownerIdentityId: input.ownerIdentityId } : {}),
        requireVerifiedOwner: provider === "google" || input.role === "OWNER",
        metadata: input.metadata ?? {},
      };
      try {
        return await deps.repository.bind(repositoryInput);
      } catch (error) {
        // error-policy:J1 Repository authorization/not-found failures become
        // stable service errors; unexpected database failures still propagate.
        return translateRepositoryError(error);
      }
    },

    list(organizationId, agentId) {
      return deps.repository.list(
        nonempty(organizationId, "organizationId"),
        nonempty(agentId, "agentId"),
      );
    },

    async getExecutionBinding(args) {
      const binding = await deps.repository.getExecutionBinding({
        organizationId: nonempty(args.organizationId, "organizationId"),
        agentId: nonempty(args.agentId, "agentId"),
        bindingId: nonempty(args.bindingId, "bindingId"),
        ...(args.provider ? { provider: args.provider.toLowerCase() } : {}),
      });
      if (!binding) {
        throw new ApiError(404, "CONNECTOR_BINDING_NOT_FOUND", "Connector binding not found.");
      }
      return binding;
    },

    async revoke(args) {
      const revoked = await deps.repository.revoke({
        organizationId: nonempty(args.organizationId, "organizationId"),
        agentId: nonempty(args.agentId, "agentId"),
        bindingId: nonempty(args.bindingId, "bindingId"),
      });
      if (!revoked) {
        throw new ApiError(404, "CONNECTOR_BINDING_NOT_FOUND", "Connector binding not found.");
      }
    },
  };
}

export const agentConnectorBindingsService = createAgentConnectorBindingsService({
  repository: agentConnectorBindingsRepository,
});
