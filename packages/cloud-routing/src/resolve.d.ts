import { type FeaturePolicy, type FeaturePolicyMap } from "./features.js";
import type { CloudRoute, FeatureCloudRoute, RouteSpec } from "./types.js";
export interface RuntimeSettings {
  getSetting(key: string): string | boolean | number | null | undefined;
}
export declare function toRuntimeSettings(runtime: {
  getSetting(key: string): unknown;
}): RuntimeSettings;
export declare function cloudServiceApisBaseUrl(
  runtime: RuntimeSettings,
  service: string,
): {
  baseUrl: string;
  headers: Record<string, string>;
} | null;
export declare function isCloudConnected(runtime: RuntimeSettings): boolean;
export declare function resolveCloudRoute(
  runtime: RuntimeSettings,
  spec: RouteSpec,
): CloudRoute;
export declare function getFeaturePolicy(
  runtime: RuntimeSettings,
  feature: string,
): FeaturePolicy;
export declare function getFeaturePolicyMap(
  runtime: RuntimeSettings,
): FeaturePolicyMap;
export declare function resolveFeatureCloudRoute(
  runtime: RuntimeSettings,
  feature: string,
  spec: RouteSpec,
  policyOverride?: FeaturePolicy,
): FeatureCloudRoute;
