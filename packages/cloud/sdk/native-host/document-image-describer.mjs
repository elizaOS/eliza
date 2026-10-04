import { NativeCloudServiceError } from "./errors.mjs";
/** Account-bound runtime facade over Eliza's existing Cloud vision implementation. */
export function createDocumentImageDescriber({
  documentRuntime,
  model,
  readAuthority,
  assertOwner,
  recordUsage = () => {},
}) {
  if (
    !documentRuntime ||
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) ||
    typeof readAuthority !== "function" ||
    typeof assertOwner !== "function"
  )
    throw new NativeCloudServiceError(
      "Document vision configuration unavailable",
    );
  return async (params) => {
    const check = async () => {
      params.signal?.throwIfAborted();
      await assertOwner();
      params.signal?.throwIfAborted();
    };
    await check();
    const { apiKey, apiBaseUrl } = await readAuthority();
    await check();
    const settings = {
      ELIZAOS_CLOUD_API_KEY: apiKey,
      ELIZAOS_CLOUD_BASE_URL: apiBaseUrl,
      ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL: model,
      DISABLE_IMAGE_DESCRIPTION: "false",
    };
    const runtime = {
      getSetting: (key) => settings[key],
      emitEvent: (_type, event) => {
        // Preserve usage counts only; runtime/settings and document text stay host-private.
        const tokens = event?.tokens;
        if (
          tokens &&
          ["prompt", "completion", "total"].every(
            (key) => Number.isFinite(tokens[key]) && tokens[key] >= 0,
          )
        )
          recordUsage({
            model,
            tokens: {
              prompt: tokens.prompt,
              completion: tokens.completion,
              total: tokens.total,
            },
          });
      },
    };
    const authority = documentRuntime.resolveCloudSdkAuthorityTuple(runtime);
    if (
      !authority.outboundAllowed ||
      authority.apiKey !== apiKey ||
      authority.apiBaseUrl !== apiBaseUrl
    )
      throw new NativeCloudServiceError("Document vision authority mismatch");
    // Ambient app attribution must not redirect this account-owned inference call.
    if (
      documentRuntime.getNativeApplicationSlot(runtime) ||
      documentRuntime.getAppId(runtime)
    )
      throw new NativeCloudServiceError(
        "Document vision attribution requires explicit configuration",
      );
    const result = await documentRuntime.handleImageDescription(
      runtime,
      params,
    );
    await check();
    return result;
  };
}
