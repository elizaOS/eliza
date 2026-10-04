/** Public repository-tooling helpers; importing this barrel performs no runtime setup. */
export {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getInstalledPackageEntry,
  getInstalledPackageRoot,
  getUiSourceRoot,
  resolveModuleEntry,
} from "./package-paths.ts";
export { getFreePort, waitForChildExit } from "./process-fixtures.ts";
export { testOutputPath } from "./test-output.ts";
