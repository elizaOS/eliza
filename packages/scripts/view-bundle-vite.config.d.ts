import type { UserConfig } from "vite";

type ViewBundleOptions = {
  packageName: string;
  viewId: string;
  entry: string;
  outDir?: string;
  componentExport?: string;
  additionalExternals?: string[];
  /**
   * Module specifiers this bundle resolves to a local replacement (e.g. a stub)
   * and bundles inline instead of leaving external. Lets a plugin own a
   * dependency the shared host does not — e.g. the finances view bundling its
   * own `react-plaid-link` stub rather than the shell providing it.
   */
  aliases?: Record<string, string>;
};
export declare function createViewBundleConfig(
  options: ViewBundleOptions,
): UserConfig;
//# sourceMappingURL=view-bundle-vite.config.d.ts.map
