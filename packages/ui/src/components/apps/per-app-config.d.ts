/**
 * Per-app config — launch mode, always-on-top default, and free-form
 * app-declared settings. NOT widget visibility (lives in widgets/visibility.ts).
 *
 * Persisted to localStorage under `eliza:apps:<slug>`. Subscribers receive
 * change notifications via the `storage` event so multiple windows stay in
 * sync.
 */
export type AppLaunchMode = "window" | "inline";
export interface PerAppConfig {
  launchMode: AppLaunchMode;
  alwaysOnTop: boolean;
  settings: Record<string, unknown>;
}
export declare function loadPerAppConfig(slug: string): PerAppConfig;
export declare function savePerAppConfig(
  slug: string,
  config: PerAppConfig,
): void;
export declare function subscribePerAppConfig(
  slug: string,
  listener: (config: PerAppConfig) => void,
): () => void;
export declare function getDefaultPerAppConfig(): PerAppConfig;
//# sourceMappingURL=per-app-config.d.ts.map
