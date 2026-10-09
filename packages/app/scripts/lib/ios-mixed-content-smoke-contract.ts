/**
 * iOS onboarding mixed-content smoke contract.
 *
 * WKWebView currently serves the bundled app from capacitor://localhost while
 * some historical harness text expected https://localhost. The important
 * invariant is transport behavior: the remote-connect path must be healthy over
 * REST and must not require a WebSocket from the WebView.
 */

const SUPPORTED_ORIGINS = new Set(["capacitor://localhost"]);

function resultJson(result) {
  return JSON.stringify(result);
}

export function isSupportedIosWebViewOrigin(origin) {
  const value = String(origin ?? "");
  return value.startsWith("https://localhost") || SUPPORTED_ORIGINS.has(value);
}

export function assertIosMixedContentSmokeResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error(
      `iOS mixed-content smoke returned no result: ${resultJson(result)}`,
    );
  }

  if (!isSupportedIosWebViewOrigin(result.webViewOrigin)) {
    throw new Error(
      `iOS mixed-content smoke ran from an unsupported WebView origin: ${resultJson(result)}`,
    );
  }

  if (
    String(result.webViewOrigin).startsWith("https://localhost") &&
    result.mixedContentWouldBlockWebSocket !== true
  ) {
    throw new Error(
      `iOS mixed-content smoke did not prove an insecure ws:// would be mixed content: ${resultJson(result)}`,
    );
  }

  if (
    result.webViewOrigin === "capacitor://localhost" &&
    result.mixedContentWouldBlockWebSocket !== false
  ) {
    throw new Error(
      `iOS mixed-content smoke reported an impossible mixed-content result for capacitor://localhost: ${resultJson(result)}`,
    );
  }

  if (
    !Array.isArray(result.webSocketConstructorCalls) ||
    result.webSocketConstructorCalls.length !== 0
  ) {
    throw new Error(
      `iOS mixed-content smoke attempted a WebSocket: ${resultJson(result.webSocketConstructorCalls)}`,
    );
  }

  if (result.connectionState?.state !== "connected") {
    throw new Error(
      `iOS mixed-content smoke was not connected-over-REST: ${resultJson(result.connectionState)}`,
    );
  }

  if (result.lostBackendOverlayAbsent !== true) {
    throw new Error(
      `iOS mixed-content smoke found the lost backend overlay: ${resultJson(result)}`,
    );
  }

  if (result.restHealth?.ok !== true) {
    throw new Error(
      `iOS mixed-content smoke REST health failed: ${resultJson(result.restHealth)}`,
    );
  }
}
