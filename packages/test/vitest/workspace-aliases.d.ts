/** Vite rollup alias shape; structural type avoids duplicate vite versions in Bun's typings. */
export type ModuleAlias = {
    find: string | RegExp;
    replacement: string;
};
type FallbackAliasOptions = {
    fallbackReplacement?: string;
};
type ElizaAliasOptions = {
    includeElizaAlias?: boolean;
};
export type AgentSourceAliasOptions = FallbackAliasOptions & ElizaAliasOptions;
export type AppCoreSourceAliasOptions = FallbackAliasOptions & {
    bridgeReplacement?: string;
    stubRootSpecifier?: boolean;
};
export type SharedSourceAliasOptions = ElizaAliasOptions & {
    includeConfigAlias?: boolean;
};
export type InstalledPackageAliasOptions = {
    entryKind?: "node";
    fallbackPath?: string;
};
export declare function getElizaWorkspaceRoot(repoRoot: string): string;
export declare function getOptionalResolvedAliases(aliases: ReadonlyArray<{
    find: ModuleAlias["find"];
    replacement?: string | null;
}>): ModuleAlias[];
export declare function getOptionalInstalledPackageAliases(repoRoot: string, aliases: ReadonlyArray<{
    find: ModuleAlias["find"];
    packageName: string;
    options?: InstalledPackageAliasOptions;
}>): ModuleAlias[];
export declare function getElizaCoreRolesEntry(repoRoot: string): string;
export declare function getAppCoreBridgeStubPath(repoRoot: string): string;
export declare function getAppCorePluginFallbackPath(repoRoot: string): string;
export declare function getAppCoreModuleFallbackPath(repoRoot: string): string;
export declare function getOptionalPluginSdkAliases(repoRoot: string): ModuleAlias[];
export declare function getAgentSourceAliases(sourceRoot: string | undefined, options?: AgentSourceAliasOptions): ModuleAlias[];
export declare function getAppCoreSourceAliases(sourceRoot: string | undefined, options?: AppCoreSourceAliasOptions): ModuleAlias[];
export declare function getSharedSourceAliases(sourceRoot: string | undefined, options?: SharedSourceAliasOptions): ModuleAlias[];
export declare function getUiSourceAliases(sourceRoot: string | undefined): ModuleAlias[];
export declare function getWorkspaceAppAliases(repoRoot: string, appNames: string[]): ModuleAlias[];
export declare function getWorkspacePluginAliases(repoRoot: string, pluginNames: string[]): ModuleAlias[];
export {};
//# sourceMappingURL=workspace-aliases.d.ts.map