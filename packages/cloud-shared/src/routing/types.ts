import type { FeaturePolicy } from "./features.ts";

export type CloudRouteSource = "local-key" | "cloud-proxy" | "disabled";

type RoutableSource = Exclude<CloudRouteSource, "disabled">;

type RoutableCloudRoute<TSource extends RoutableSource> = {
  source: TSource;
  baseUrl: string;
  headers: Record<string, string>;
  reason: string;
};

type DisabledCloudRoute = {
  source: "disabled";
  reason: string;
};

export type CloudRoute =
  | RoutableCloudRoute<"local-key">
  | RoutableCloudRoute<"cloud-proxy">
  | DisabledCloudRoute;

export type FeatureCloudRoute = CloudRoute & {
  feature: string;
  policy: FeaturePolicy;
};

/**
 * For `localKeyAuth.kind === "query"`, the helper still returns `source: "local-key"`
 * with `headers: {}`. The caller is responsible for appending the query parameter
 * to the request URL.
 */
export interface RouteSpec {
  service: string;
  localKeySetting: string;
  upstreamBaseUrl: string;
  localKeyAuth:
    | { kind: "header"; headerName: string }
    | { kind: "bearer" }
    | { kind: "query"; paramName: string };
}
