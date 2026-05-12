/**
 * CloudCredentialProvider — bridges plugin-workflow's `CredentialProvider`
 * service slot to Eliza Cloud's per-connector OAuth surface.
 *
 * Resolution path on `resolve(userId, credType)`:
 *   1. Look up `credType` in `credTypeToConnector` — return `null` for unmapped.
 *   2. GET `/eliza/<connector>/status` via the authenticated cloud client to
 *      check whether the user already has an active connection.
 *   3. When connected → see `RAW_TOKEN_GAP` below; we currently return
 *      `needs_auth` because the cloud does not expose raw OAuth tokens.
 *   4. When not connected → POST `/eliza/<connector>/connect/initiate` with
 *      the mapped `capabilities`; return `needs_auth` with the authUrl the
 *      cloud issued. The workflow plugin surfaces this to the user.
 *
 * RAW_TOKEN_GAP
 * -------------
 * Plugin-workflow's `credential_data` shape requires the actual access token
 * (so the workflow engine can inject it into a node's HTTP calls). The cloud
 * connector endpoints (Google / GitHub / Discord) intentionally do **not**
 * vend raw tokens to the local plugin — they hold the token server-side and
 * proxy connector calls under `/eliza/<connector>/<action>` (e.g.
 * `/eliza/google/gmail/send`). Bridging that proxy model into the workflow
 * engine is a separate piece of work (either: extend the workflow engine to
 * dispatch through cloud proxies, or add a token-vending endpoint cloud-side
 * for clients with a verified pairing). Until then this provider is honest:
 * it confirms the connection exists and either reports it cannot inject
 * (`null` / `needs_auth`) or — once the cloud exposes a vending endpoint —
 * fetches and returns the credential payload.
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
    // No-op: holds no per-instance state.
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

    const status = await this.fetchConnectorStatus(client, mapping.connector);

    if (!status.connected) {
      const authUrl =
        status.authUrl ??
        (await this.initiateConnectorAuth(client, mapping.connector, mapping.capabilities));
      if (!authUrl) {
        return null;
      }
      return { status: "needs_auth", authUrl };
    }

    // Connected, but the cloud does not expose raw tokens — see RAW_TOKEN_GAP
    // in the file header. We re-prompt for explicit user-side auth so the
    // workflow plugin reports "missing connection" instead of silently
    // injecting a stale or empty credential. When the cloud adds a token
    // vending endpoint, fetch + return `credential_data` here.
    const reauthUrl = await this.initiateConnectorAuth(
      client,
      mapping.connector,
      mapping.capabilities,
    );
    if (reauthUrl) {
      return { status: "needs_auth", authUrl: reauthUrl };
    }
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

  private async initiateConnectorAuth(
    client: CloudClientLike,
    connector: string,
    capabilities: readonly string[] | undefined,
  ): Promise<string | null> {
    if (typeof client.post !== "function") {
      return null;
    }
    const body: Record<string, unknown> = {};
    if (capabilities && capabilities.length > 0) {
      body.capabilities = [...capabilities];
    }
    const raw = (await client.post(
      `/eliza/${connector}/connect/initiate`,
      body,
    )) as CloudConnectInitiateResponse | null;
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
