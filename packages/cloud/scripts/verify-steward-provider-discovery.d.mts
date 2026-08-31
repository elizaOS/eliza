/**
 * Types the anonymous Steward discovery release boundary for TypeScript callers.
 * Raw configuration strings are validated before HTTP; successful results name
 * the verified staging surface, without carrying provider response content.
 */

export type ProviderDiscoverySurface = "upstream" | "proxy";

export interface ProviderDiscoveryConfigInput {
  baseUrl: string;
  environment: string;
  surface: string;
}

export interface ProviderDiscoveryConfig extends ProviderDiscoveryConfigInput {
  environment: "staging";
  surface: ProviderDiscoverySurface;
}

export interface ProviderDiscoveryResult {
  environment: "staging";
  surface: ProviderDiscoverySurface;
}

export type ProviderDiscoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderDiscoveryDependencies {
  fetchImpl?: ProviderDiscoveryFetch;
}

export interface ProviderDiscoveryRetryDependencies
  extends ProviderDiscoveryDependencies {
  attempts?: number;
  retryDelayMs?: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

export interface ProviderDiscoveryCliDependencies
  extends ProviderDiscoveryDependencies {
  log?: (message: string) => void;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

export function isProviderDiscoveryPayload(value: unknown): boolean;

export function parseProviderDiscoveryJson(text: string): unknown;

export function parseProviderDiscoveryArgs(
  argv: readonly string[],
): ProviderDiscoveryConfig;

export function verifyStewardProviderDiscovery(
  config: ProviderDiscoveryConfigInput,
  dependencies?: ProviderDiscoveryDependencies,
): Promise<ProviderDiscoveryResult>;

export function verifyStewardProviderDiscoveryWithRetry(
  config: ProviderDiscoveryConfigInput,
  dependencies?: ProviderDiscoveryRetryDependencies,
): Promise<ProviderDiscoveryResult>;

export function main(
  argv?: readonly string[],
  dependencies?: ProviderDiscoveryCliDependencies,
): Promise<void>;
