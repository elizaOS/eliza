/**
 * iOS onboarding mixed-content smoke contract.
 *
 * WKWebView currently serves the bundled app from capacitor://localhost while
 * some historical harness text expected https://localhost. The transport proof
 * follows the real origin: HTTPS must avoid an insecure mixed-content socket,
 * while capacitor:// must establish the ordinary agent's realtime socket.
 */

const SUPPORTED_ORIGINS = new Set(["capacitor://localhost"]);

function resultJson(result) {
  return JSON.stringify(result);
}

export function isSupportedIosWebViewOrigin(origin) {
  const value = String(origin ?? "");
  return value.startsWith("https://localhost") || SUPPORTED_ORIGINS.has(value);
}

function matchesExpectedWebSocketEndpoint(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") {
    return false;
  }
  try {
    const url = new URL(candidate);
    url.search = "";
    url.hash = "";
    return url.href === expected;
  } catch {
    return false;
  }
}

export function assertIosMixedContentSmokeResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error(
      `iOS mixed-content smoke returned no result: ${resultJson(result)}`,
    );
  }

  if (result.phase === "complete" && result.ok !== true) {
    throw new Error(
      `iOS mixed-content smoke completed unsuccessfully: ${resultJson(result)}`,
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

  if (!Array.isArray(result.webSocketConstructorCalls)) {
    throw new Error(
      `iOS mixed-content smoke lacked WebSocket constructor evidence: ${resultJson(result)}`,
    );
  }
  if (!Array.isArray(result.webSocketOpenCalls)) {
    throw new Error(
      `iOS mixed-content smoke lacked WebSocket open evidence: ${resultJson(result)}`,
    );
  }

  if (result.webViewOrigin === "capacitor://localhost") {
    if (result.webSocketExpected !== true) {
      throw new Error(
        `iOS Capacitor smoke did not require its realtime WebSocket: ${resultJson(result)}`,
      );
    }
    if (
      !result.webSocketConstructorCalls.some((url) =>
        matchesExpectedWebSocketEndpoint(url, result.expectedWebSocketUrl),
      )
    ) {
      throw new Error(
        `iOS Capacitor smoke did not construct the expected WebSocket: ${resultJson(result)}`,
      );
    }
    if (
      !result.webSocketOpenCalls.some((url) =>
        matchesExpectedWebSocketEndpoint(url, result.expectedWebSocketUrl),
      )
    ) {
      throw new Error(
        `iOS Capacitor smoke did not open the expected WebSocket: ${resultJson(result)}`,
      );
    }
  } else {
    if (result.webSocketExpected !== false) {
      throw new Error(
        `iOS HTTPS mixed-content smoke unexpectedly required a WebSocket: ${resultJson(result)}`,
      );
    }
    if (
      result.webSocketConstructorCalls.length !== 0 ||
      result.webSocketOpenCalls.length !== 0
    ) {
      throw new Error(
        `iOS HTTPS mixed-content smoke attempted a blocked WebSocket: ${resultJson(result)}`,
      );
    }
  }

  if (result.connectionState?.state !== "connected") {
    throw new Error(
      `iOS mixed-content smoke transport was not connected: ${resultJson(result.connectionState)}`,
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
