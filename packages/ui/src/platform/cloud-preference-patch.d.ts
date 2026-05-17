import type { CloudPreferenceClientLike as ClientLike } from "./types";

type StorageConfig = Record<string, unknown>;
export declare function shouldPreferLocalProviderConfig(
  config: StorageConfig | null | undefined,
): boolean;
export declare function normalizeConfigForLocalProviderPreference(
  config: StorageConfig | null | undefined,
): StorageConfig | null | undefined;
export declare function shouldMaskInactiveCloudStatus(args: {
  config: StorageConfig | null | undefined;
  status: unknown;
}): boolean;
export declare function installLocalProviderCloudPreferencePatch(
  client: ClientLike,
): () => void;
//# sourceMappingURL=cloud-preference-patch.d.ts.map
