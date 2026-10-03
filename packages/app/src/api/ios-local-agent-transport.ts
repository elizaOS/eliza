/** Preserves the app host transport entrypoint while UI owns its shared runtime lifecycle. */
export {
  handleIosLocalAgentNativeRequest,
  type IosLocalAgentNativeRequestOptions,
  type IosLocalAgentNativeRequestResult,
  installIosLocalAgentFetchBridge,
  installIosLocalAgentNativeRequestBridge,
  iosInProcessAgentTransportForUrl,
  isIosInProcessLocalAgentBase,
  isIosInProcessLocalAgentUrl,
  primeIosFullBunRuntime,
} from "@elizaos/ui/api/ios-local-agent-transport";
