import type { FeaturePolicy } from "./features.js";

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

export interface RouteSpec {
  service: string;
  localKeySetting: string;
  upstreamBaseUrl: string;
  localKeyAuth:
    | { kind: "header"; headerName: string }
    | { kind: "bearer" }
    | { kind: "query"; paramName: string };
}
