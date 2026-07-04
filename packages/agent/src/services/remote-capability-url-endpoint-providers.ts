/**
 * URL-backed remote capability endpoint providers. Wraps a bare base URL (plus
 * optional endpoint id, token, and allowed-module list) into a
 * `RemoteCapabilityEndpointProvider` whose `provision` validates the URL
 * (http/https only, no embedded credentials, no path/query separators in the
 * endpoint id) and returns a normalized endpoint. Exports ready-made providers
 * for the e2b, home-machine, mobile-companion, and desktop-companion runtimes.
 */
import type {
  ProvisionedRemoteCapabilityEndpoint,
  RemoteCapabilityEndpointProvider,
  RemoteCapabilityEndpointProviderId,
} from "./remote-capability-endpoint-provider.ts";
import type { RemoteCapabilityEndpointConfig } from "./remote-capability-router.ts";

export type UrlRemoteCapabilityEndpointProviderOptions = {
  baseUrl: string;
  endpointId?: string;
  token?: string;
  allowedModuleIds?: string[];
  metadata?: Record<string, unknown>;
};

export type UrlRemoteCapabilityEndpointProviderDefaults = {
  endpointId?: string;
};

export function urlRemoteCapabilityEndpointProvider(
  providerId: RemoteCapabilityEndpointProviderId,
  defaults: UrlRemoteCapabilityEndpointProviderDefaults = {},
): RemoteCapabilityEndpointProvider<UrlRemoteCapabilityEndpointProviderOptions> {
  return {
    id: providerId,
    provision: async (options) =>
      provisionUrlRemoteCapabilityEndpoint(providerId, defaults, options),
  };
}

export const e2bCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("e2b");

export const homeMachineCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("home-machine");

export const mobileCompanionCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("mobile-companion");

export const desktopCompanionCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("desktop-companion");

function provisionUrlRemoteCapabilityEndpoint(
  providerId: RemoteCapabilityEndpointProviderId,
  defaults: UrlRemoteCapabilityEndpointProviderDefaults,
  options: UrlRemoteCapabilityEndpointProviderOptions,
): ProvisionedRemoteCapabilityEndpoint {
  const endpoint: RemoteCapabilityEndpointConfig = {
    id: normalizeEndpointId(
      options.endpointId ?? defaults.endpointId ?? providerId,
    ),
    baseUrl: normalizeEndpointBaseUrl(options.baseUrl),
    ...optionalToken(options.token),
  };
  return {
    providerId,
    endpoint,
    ...allowedModuleIdsResult(options.allowedModuleIds),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

function normalizeEndpointId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      "Remote capability endpoint id must be a non-empty string.",
    );
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("?")
  ) {
    throw new Error(
      `Remote capability endpoint id "${value}" must not contain path or query separators.`,
    );
  }
  return trimmed;
}

function normalizeEndpointBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Remote capability endpoint baseUrl is required.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid remote capability endpoint baseUrl: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Remote capability endpoint baseUrl "${value}" must use http or https.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `Remote capability endpoint baseUrl "${value}" must not include embedded credentials.`,
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function optionalToken(token: string | undefined): { token?: string } {
  const normalized = token?.trim();
  return normalized ? { token: normalized } : {};
}

function allowedModuleIdsResult(
  value: string[] | undefined,
): Partial<Pick<ProvisionedRemoteCapabilityEndpoint, "allowedModuleIds">> {
  if (value === undefined) return {};
  const allowedModuleIds = [
    ...new Set(value.map((item) => item.trim())),
  ].filter(Boolean);
  return allowedModuleIds.length === 0 ? {} : { allowedModuleIds };
}
