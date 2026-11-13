/**
 * Resolves a provider connection into the single validated shape the HTTP
 * client accepts: an explicit endpoint origin, an opaque connection id and an
 * optional bearer credential. Resolution is strict: an invalid or missing
 * configuration throws; there is no fallback to another endpoint.
 */

import { ManagedProviderError } from "./errors";

/** Opaque connection handles: `conn_` plus at least 16 id chars. */
const OPAQUE_CONNECTION_ID_PATTERN = /^conn_[A-Za-z0-9_-]{16,}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export interface ProviderConnectionConfig {
  providerId: string;
  /**
   * Caller-owned stable opaque handle for this exact account. It must not
   * encode an endpoint, account name, credential, or other provider data.
   */
  connectionId: string;
  /** Provider API origin. */
  baseUrl: string;
  /** Credential sent as a bearer token; may be absent for providers that
   * authenticate another way or need none. */
  credential?: string;
}

export interface ResolvedProviderConnection {
  readonly providerId: string;
  /** Opaque handle propagated on every request for audit correlation. */
  readonly connectionId: string;
  /** Origin every request is pinned to. */
  readonly baseOrigin: string;
  /** Bearer credential, when the provider requires one. */
  readonly credential?: string;
}

function parseOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ManagedProviderError("The provider endpoint is invalid.", {
      code: "INVALID_INPUT",
      cause: error,
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ManagedProviderError(
      "The provider endpoint cannot contain userinfo, query, or fragment data.",
      { code: "INVALID_INPUT" },
    );
  }
  if (url.pathname !== "/") {
    throw new ManagedProviderError(
      "The provider endpoint must be an origin URL.",
      { code: "INVALID_INPUT" },
    );
  }
  return url;
}

/** Validates one explicit connection configuration. */
export function resolveProviderConnection(
  config: ProviderConnectionConfig,
): ResolvedProviderConnection {
  if (!PROVIDER_ID_PATTERN.test(config.providerId)) {
    throw new ManagedProviderError("The provider id is invalid.", {
      code: "INVALID_INPUT",
    });
  }
  if (!OPAQUE_CONNECTION_ID_PATTERN.test(config.connectionId)) {
    throw new ManagedProviderError(
      "Connections require a stable opaque connection id.",
      { code: "INVALID_INPUT", context: { providerId: config.providerId } },
    );
  }
  const origin = parseOrigin(config.baseUrl);
  if (config.credential !== undefined && config.credential.length === 0) {
    throw new ManagedProviderError("A provider credential cannot be empty.", {
      code: "INVALID_INPUT",
      context: { providerId: config.providerId },
    });
  }
  return {
    providerId: config.providerId,
    connectionId: config.connectionId,
    baseOrigin: origin.origin,
    credential: config.credential,
  };
}
