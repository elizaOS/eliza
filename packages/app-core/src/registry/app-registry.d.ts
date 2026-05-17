export interface ElizaCuratedAppDefinition {
  slug: string;
  canonicalName: string;
  aliases: string[];
}
/**
 * Register an additional curated app definition at runtime.
 *
 * Symbol-keyed global so app/shared/plugin consumers read the same registry
 * regardless of which package they import from.
 */
export declare function registerCuratedApp(
  def: ElizaCuratedAppDefinition,
): void;
export declare function getRegisteredCuratedApps(): ElizaCuratedAppDefinition[];
//# sourceMappingURL=app-registry.d.ts.map
