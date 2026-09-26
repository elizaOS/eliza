/**
 * Re-export of the shared model-file verification module. The canonical
 * implementation lives in `@elizaos/plugin-native-inference/model-catalog` because both
 * the server (`@elizaos/app`) and the UI client (`@elizaos/ui`)
 * compute the same SHA256 / GGUF-magic checks against on-disk models.
 */
export {
	__registryPathForTests,
	hashFile,
	type VerifyResult,
	type VerifyState,
	verifyInstalledModel,
} from "@elizaos/plugin-native-inference/model-catalog/verify";
