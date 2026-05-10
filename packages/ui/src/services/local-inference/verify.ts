/**
 * Re-export of the shared model-file verification module. The canonical
 * implementation lives in `@elizaos/shared/local-inference` because both
 * the server (`@elizaos/app-core`) and the UI client (`@elizaos/ui`)
 * compute the same SHA256 / GGUF-magic checks against on-disk models.
 */
export {
  __registryPathForTests,
  hashFile,
  verifyInstalledModel,
  type VerifyResult,
  type VerifyState,
} from "@elizaos/shared";
