if (
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1" &&
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS !== "1"
) {
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS = "1";
}

const upstream = await import(
  "../packages/app-core/test/eliza-package-paths.ts"
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
