/**
 * Re-exports the local-inference filesystem paths from @elizaos/shared so UI
 * callers use one canonical set of model/registry directories.
 */
export {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "@elizaos/shared/local-inference/paths";
