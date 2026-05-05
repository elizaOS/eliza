const upstream = await import(
  "../eliza/packages/app-core/test/eliza-package-paths.ts"
);

export const getAppCoreSourceRoot = upstream.getAppCoreSourceRoot;
export const getAutonomousSourceRoot = upstream.getAutonomousSourceRoot;
export const getElizaCoreEntry = upstream.getElizaCoreEntry;
export const getInstalledPackageEntry = upstream.getInstalledPackageEntry;
export const getInstalledPackageNamedExport =
  upstream.getInstalledPackageNamedExport;
export const getInstalledPackageRoot = upstream.getInstalledPackageRoot;
export const getSharedSourceRoot = upstream.getSharedSourceRoot;
export const getUiSourceRoot = upstream.getUiSourceRoot;
export const resolveModuleEntry = upstream.resolveModuleEntry;
