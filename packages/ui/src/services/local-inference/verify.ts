/**
 * Re-exports installed-model verification (file hashing, verify state) from the
 * local-inference shared surface.
 */
export {
  __registryPathForTests,
  hashFile,
  type VerifyResult,
  type VerifyState,
  verifyInstalledModel,
} from "@elizaos/shared/local-inference/verify";
