export type CloudRouteSource = "local-key" | "cloud-proxy" | "disabled";

/** Discriminated union — callers branch on `source` once at init and exit. */
export type CloudRoute =
  | {
      source: "local-key";
      baseUrl: string;
      headers: Record<string, string>;
      reason: string;
    }
  | {
      source: "cloud-proxy";
      baseUrl: string;
      headers: Record<string, string>;
      reason: string;
    }
  | {
      source: "disabled";
      reason: string;
    };

/**
 * Required inputs to resolve a cloud route. All required — no optionals that hide intent.
 *
 * For `localKeyAuth.kind === "query"`, the helper still returns `source: "local-key"`
 * with `headers: {}`. The caller is responsible for appending the query parameter
 * to the request URL.
 */
export interface RouteSpec {
  /** Service identifier used in the cloud URL (e.g. "birdeye", "jupiter"). Lowercase, kebab-case. */
  service: string;
  /** Runtime setting key for the local API key (e.g. "BIRDEYE_API_KEY"). */
  localKeySetting: string;
  /** Upstream base URL for direct calls (e.g. "https://public-api.birdeye.so"). No trailing slash. */
  upstreamBaseUrl: string;
  /** How the local API key is sent upstream when source === "local-key". */
  localKeyAuth:
    | { kind: "header"; headerName: string }
    | { kind: "bearer" }
    | { kind: "query"; paramName: string };
}
