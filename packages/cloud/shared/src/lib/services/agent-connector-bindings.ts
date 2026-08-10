/**
 * Product-facing control plane for agent connector bindings. It validates the
 * credential-free binding contract and delegates tenant/ownership checks to an
 * atomic repository operation.
 */
import type { AgentConnectorBinding } from "@elizaos/core";
import { GOOGLE_WORKSPACE_MCP_RESOURCES } from "@elizaos/shared/contracts";
import {
  AgentConnectorBindingRepositoryError,
  AgentConnectorBindingsRepository,
  type AgentConnectorExecutionBinding,
  agentConnectorBindingsRepository,
  type BindAgentConnectorInput,
} from "../../db/repositories/agent-connector-bindings";

const VALID_ROLES = new Set(["OWNER", "AGENT", "TEAM"]);
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

export class AgentConnectorBindingError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentConnectorBindingError";
  }
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
    throw new AgentConnectorBindingError(400, "CONNECTOR_BINDING_INVALID", `${name} is required.`);
  }
  return normalized;
}

function stringList(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values)) {
    throw new AgentConnectorBindingError(
      400,
      "CONNECTOR_BINDING_INVALID",
      `${name} must be an array.`,
    );
  }
  return [...new Set(values.map((value) => nonempty(value, `${name} entry`)))];
}

function translateRepositoryError(error: unknown): never {
  if (!(error instanceof AgentConnectorBindingRepositoryError)) throw error;
  switch (error.code) {
    case "AGENT_NOT_FOUND":
    case "CREDENTIAL_NOT_FOUND":
      throw new AgentConnectorBindingError(404, error.code, error.message);
    case "PROVIDER_MISMATCH":
      throw new AgentConnectorBindingError(409, error.code, error.message);
    case "OWNER_NOT_VERIFIED":
      throw new AgentConnectorBindingError(403, error.code, error.message);
    case "UNSUPPORTED_PRODUCT":
      throw new AgentConnectorBindingError(400, error.code, error.message);
  }
}

export function createAgentConnectorBindingsService(
  deps: AgentConnectorBindingsServiceDeps,
): AgentConnectorBindingsService {
  return {
    async bind(input) {
      if (!VALID_ROLES.has(input.role)) {
        throw new AgentConnectorBindingError(400, "CONNECTOR_BINDING_INVALID", "Invalid role.");
      }
      const provider = nonempty(input.provider, "provider").toLowerCase();
      const selectedProducts = [
        ...new Set(
          stringList(input.selectedProducts, "selectedProducts").map((product) =>
            product.toLowerCase() === "workspace" ? "universalSearch" : product,
          ),
        ),
      ];
      const knownProducts = new Set(
        Object.keys(GOOGLE_WORKSPACE_MCP_RESOURCES).map((product) => product.toLowerCase()),
      );
      const unknownProducts =
        provider === "google"
          ? selectedProducts.filter((product) => !knownProducts.has(product.toLowerCase()))
          : [];
      if (unknownProducts.length > 0) {
        throw new AgentConnectorBindingError(
          400,
          "CONNECTOR_BINDING_INVALID",
          `Unsupported Google MCP products: ${unknownProducts.join(", ")}.`,
        );
      }
      const repositoryInput: BindAgentConnectorInput = {
        organizationId: nonempty(input.organizationId, "organizationId"),
        agentId: nonempty(input.agentId, "agentId"),
        platformCredentialId: nonempty(input.platformCredentialId, "platformCredentialId"),
        provider,
        role: input.role,
        purposes: stringList(input.purposes ?? ["automation"], "purposes"),
        accessGate: nonempty(input.accessGate ?? "owner_binding", "accessGate"),
        selectedProducts,
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
        throw new AgentConnectorBindingError(
          404,
          "CONNECTOR_BINDING_NOT_FOUND",
          "Connector binding not found.",
        );
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
        throw new AgentConnectorBindingError(
          404,
          "CONNECTOR_BINDING_NOT_FOUND",
          "Connector binding not found.",
        );
      }
    },
  };
}

export const agentConnectorBindingsService = createAgentConnectorBindingsService({
  repository: agentConnectorBindingsRepository,
});
