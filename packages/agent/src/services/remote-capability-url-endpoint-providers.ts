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
  endpointId: string;
};

export function urlRemoteCapabilityEndpointProvider(
  providerId: RemoteCapabilityEndpointProviderId,
  defaults: UrlRemoteCapabilityEndpointProviderDefaults,
): RemoteCapabilityEndpointProvider<UrlRemoteCapabilityEndpointProviderOptions> {
  return {
    id: providerId,
    provision: async (options) =>
      provisionUrlRemoteCapabilityEndpoint(providerId, defaults, options),
  };
}

export const e2bCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("e2b", {
    endpointId: "e2b-capability",
  });

export const homeMachineCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("home-machine", {
    endpointId: "home-machine-capability",
  });

export const mobileCompanionCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("mobile-companion", {
    endpointId: "mobile-companion-capability",
  });

export const desktopCompanionCapabilityEndpointProvider =
  urlRemoteCapabilityEndpointProvider("desktop-companion", {
    endpointId: "desktop-companion-capability",
  });

function provisionUrlRemoteCapabilityEndpoint(
  providerId: RemoteCapabilityEndpointProviderId,
  defaults: UrlRemoteCapabilityEndpointProviderDefaults,
  options: UrlRemoteCapabilityEndpointProviderOptions,
): ProvisionedRemoteCapabilityEndpoint {
  const endpoint: RemoteCapabilityEndpointConfig = {
    id: normalizeEndpointId(options.endpointId ?? defaults.endpointId),
    baseUrl: normalizeEndpointBaseUrl(options.baseUrl),
    ...(options.token === undefined ? {} : { token: options.token }),
  };
  return {
    providerId,
    endpoint,
    ...(options.allowedModuleIds === undefined
      ? {}
      : { allowedModuleIds: options.allowedModuleIds }),
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
