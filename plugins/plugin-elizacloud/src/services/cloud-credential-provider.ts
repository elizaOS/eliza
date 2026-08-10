/**
 * CloudCredentialProvider — bridges plugin-workflow's `CredentialProvider`
 * service slot to Eliza Cloud's connector control plane.
 *
 * Resolution path on `resolve(userId, credType)`:
 *   1. Look up `credType` in `credTypeToConnector` — return `null` for unmapped.
 *   2. For Google, list this runtime agent's connector bindings. Credential
 *      identity remains private to Cloud.
 *   3. When connected, return `null` because a binding authorizes curated MCP
 *      execution but does not authorize raw-token export to a workflow node.
 *   4. When not connected, initiate generic OAuth with an agent-binding
 *      request. The callback stores the credential and binding atomically.
 *
 * RAW_TOKEN_GAP
 * -------------
 * Plugin-workflow's `credential_data` shape requires the actual access token
 * (so the workflow engine can inject it into a node's HTTP calls). The cloud
 * connector control plane intentionally does **not** vend raw tokens to the
 * local plugin. Google execution is binding-scoped and calls official MCP
 * resources inside the hosted runtime. Workflow support therefore requires a
 * future binding-aware tool executor, not resurrection of a token-vending or
 * provider-specific REST proxy. Until then this provider fails closed.
 *
 * No fallbacks. No fake tokens. The provider fails closed.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { credTypeToConnector, supportedCredTypes } from "../lib/credential-type-map";
import type { CloudAuthLike } from "../lib/cloud-connection";

// Inlined to avoid a hard compile-time dep on @elizaos/plugin-workflow.
// The runtime duck-types the service via the shared service-type string.
const WORKFLOW_CREDENTIAL_PROVIDER_TYPE = "workflow_credential_provider";

export type CredentialProviderResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

export interface CheckCredentialTypesResult {
  supported: string[];
  unsupported: string[];
}

interface CloudConnectorStatus {
  connected: boolean;
  reason?: string;
  authUrl?: string;
}

interface CloudConnectInitiateResponse {
  authUrl?: string;
}

interface CloudClientLike {
  get?: (path: string) => Promise<unknown>;
  post?: (path: string, body?: unknown) => Promise<unknown>;
}

function isCloudAuthLike(value: unknown): value is CloudAuthLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof Reflect.get(value, "getClient") === "function";
}

function isCloudClientLike(value: unknown): value is CloudClientLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const get = Reflect.get(value, "get");
  const post = Reflect.get(value, "post");
  return (
    (get === undefined || typeof get === "function") &&
    (post === undefined || typeof post === "function")
  );
}

export class CloudCredentialProvider extends Service {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_PROVIDER_TYPE;

  override capabilityDescription =
    "Resolves workflow node credentials via the user's paired Eliza Cloud account.";

  static async start(runtime: IAgentRuntime): Promise<CloudCredentialProvider> {
    return new CloudCredentialProvider(runtime);
  }

  override async stop(): Promise<void> {
    // Holds no per-instance state.
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    const mapping = credTypeToConnector.get(credType);
    if (!mapping) {
      return null;
    }

    const client = this.getCloudClient();
    if (!client) {
      logger.debug(
        { src: "plugin:elizacloud:credential-provider", credType },
        "CLOUD_AUTH unavailable — cannot resolve workflow credentials",
      );
      return null;
    }

    const status =
      mapping.connector === "google"
        ? await this.fetchAgentConnectorStatus(
            client,
            mapping.connector,
            mapping.products ?? [],
          )
        : await this.fetchConnectorStatus(client, mapping.connector);

    if (!status.connected) {
      const authUrl =
        status.authUrl ??
        (await this.initiateConnectorAuth(
          client,
          mapping.connector,
          mapping.products,
          mapping.scopes,
        ));
      if (!authUrl) {
        return null;
      }
      return { status: "needs_auth", authUrl };
    }

    // Connected does not imply a raw credential can be exported into an
    // arbitrary workflow node. The Cloud runtime may execute curated MCP
    // tools through this binding, but this provider still fails closed.
    return null;
  }

  checkCredentialTypes(credTypes: string[]): CheckCredentialTypesResult {
    const supported: string[] = [];
    const unsupported: string[] = [];
    for (const t of credTypes) {
      if (supportedCredTypes.has(t)) {
        supported.push(t);
      } else {
        unsupported.push(t);
      }
    }
    return { supported, unsupported };
  }

  // ─── internals ───────────────────────────────────────────────────────

  private getCloudClient(): CloudClientLike | null {
    const cloudAuth = this.runtime.getService("CLOUD_AUTH");
    if (!isCloudAuthLike(cloudAuth)) {
      return null;
    }
    const client = cloudAuth.getClient?.();
    if (!isCloudClientLike(client)) {
      return null;
    }
    return client;
  }

  private async fetchConnectorStatus(
    client: CloudClientLike,
    connector: string,
  ): Promise<CloudConnectorStatus> {
    if (typeof client.get !== "function") {
      return { connected: false };
    }
    const raw = await client.get(`/eliza/${connector}/status`);
    return shapeConnectorStatus(raw);
  }

  private async fetchAgentConnectorStatus(
    client: CloudClientLike,
    connector: string,
    products: readonly string[],
  ): Promise<CloudConnectorStatus> {
    if (typeof client.get !== "function") {
      return { connected: false };
    }
    const raw = await client.get(
      `/eliza/agents/${String(this.runtime.agentId)}/connectors`,
    );
    if (!Array.isArray(raw)) return { connected: false };
    const connected = raw.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const binding = candidate as Record<string, unknown>;
      if (binding.provider !== connector || binding.status !== "connected") return false;
      if (!Array.isArray(binding.selectedProducts)) return false;
      const selected = new Set(
        binding.selectedProducts.filter((value): value is string => typeof value === "string"),
      );
      return products.every((product) => selected.has(product));
    });
    return { connected };
  }

  private async initiateConnectorAuth(
    client: CloudClientLike,
    connector: string,
    products: readonly string[] | undefined,
    scopes: readonly string[] | undefined,
  ): Promise<string | null> {
    if (typeof client.post !== "function") {
      return null;
    }
    const body: Record<string, unknown> = {};
    let path = `/eliza/${connector}/connect/initiate`;
    if (connector === "google") {
      if (!products || products.length === 0) return null;
      path = "/oauth/google/initiate";
      body.connectionRole = "owner";
      body.scopes = [...(scopes ?? [])];
      body.agentBinding = {
        agentId: String(this.runtime.agentId),
        role: "OWNER",
        selectedProducts: [...products],
        isDefault: true,
      };
    }
    const raw = (await client.post(path, body)) as CloudConnectInitiateResponse | null;
    const authUrl = raw?.authUrl;
    return typeof authUrl === "string" && authUrl.length > 0 ? authUrl : null;
  }
}

function shapeConnectorStatus(raw: unknown): CloudConnectorStatus {
  if (!raw || typeof raw !== "object") {
    return { connected: false };
  }
  const obj = raw as Record<string, unknown>;
  const connected = obj.connected === true;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  const authUrl = typeof obj.authUrl === "string" ? obj.authUrl : undefined;
  return { connected, reason, authUrl };
}
