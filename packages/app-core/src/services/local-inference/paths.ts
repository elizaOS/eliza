/**
 * Re-export of the shared `local-inference` path resolution. The
 * canonical implementation lives in `@elizaos/shared/local-inference`
 * because both the server (`@elizaos/app-core`) and the UI client
 * (`@elizaos/ui`) need byte-identical path semantics.
 */
export {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "@elizaos/shared";
