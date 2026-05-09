/**
 * CloudBootstrapService — service-port that exposes Eliza Cloud bootstrap
 * verification endpoints to `app-core` via the runtime service registry.
 *
 * The actual JWKS fetch / cache and bootstrap-token verify path lives in
 * `app-core` (`services/cloud-jwks-store.ts` and `api/auth/bootstrap-token.ts`).
 * This service intentionally has a minimal surface: it answers questions
 * about the cloud trust anchor (issuer, JWKS URL, revocation list URL,
 * expected container id) so that `app-core` does not need to import
 * directly from `@elizaos/plugin-elizacloud`.
 *
 * Hard rule (per remote-auth-hardening-plan §3.2): no fail-open. If the
 * cloud issuer is not configured, `getExpectedIssuer()` throws and the
 * consumer must reject the bootstrap exchange — the runtime never silently
 * trusts a default URL.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export interface CloudBootstrapService {
  /** Returns `${ELIZA_CLOUD_ISSUER}/.well-known/jwks.json`. */
  getJwksUrl(): string;
  /** Returns `${ELIZA_CLOUD_ISSUER}/.well-known/revocations.json`. */
  getRevocationListUrl(): string;
  /** Returns the configured `ELIZA_CLOUD_ISSUER`. Throws when unset. */
  getExpectedIssuer(): string;
  /** Returns the configured `ELIZA_CLOUD_CONTAINER_ID`, or `null` when unset. */
  getExpectedContainerId(): string | null;
}

type ProcessEnvLike = Record<string, string | undefined>;

function readEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

function readSetting(runtime: IAgentRuntime | undefined, key: string): string | null {
  if (runtime && typeof runtime.getSetting === "function") {
    const value = runtime.getSetting(key);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const fromEnv = readEnv()[key];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return null;
}

function trimTrailingSlash(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

export class CloudBootstrapServiceImpl extends Service implements CloudBootstrapService {
  static serviceType = "CLOUD_BOOTSTRAP";
  capabilityDescription =
    "Exposes Eliza Cloud bootstrap-token trust anchor (issuer, JWKS URL, revocation list URL, expected container id) to app-core";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudBootstrapServiceImpl(runtime);
    const issuer = readSetting(runtime, "ELIZA_CLOUD_ISSUER");
    const containerId = readSetting(runtime, "ELIZA_CLOUD_CONTAINER_ID");
    if (issuer) {
      logger.info(
        `[CloudBootstrap] Trust anchor configured (issuer=${issuer}, containerId=${containerId ?? "<unset>"})`
      );
    } else {
      logger.debug(
        "[CloudBootstrap] ELIZA_CLOUD_ISSUER unset — bootstrap-token verification will reject until configured"
      );
    }
    return service;
  }

  async stop(): Promise<void> {
    // No persistent state to tear down.
  }

  getExpectedIssuer(): string {
    const issuer = readSetting(this.runtime, "ELIZA_CLOUD_ISSUER");
    if (!issuer) {
      throw new Error(
        "ELIZA_CLOUD_ISSUER is not configured — bootstrap-token verification cannot proceed"
      );
    }
    return trimTrailingSlash(issuer);
  }

  getJwksUrl(): string {
    return `${this.getExpectedIssuer()}/.well-known/jwks.json`;
  }

  getRevocationListUrl(): string {
    return `${this.getExpectedIssuer()}/.well-known/revocations.json`;
  }

  getExpectedContainerId(): string | null {
    return readSetting(this.runtime, "ELIZA_CLOUD_CONTAINER_ID");
  }
}
