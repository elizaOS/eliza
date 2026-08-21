/**
 * Adapts one canonical browser native-message request to the authenticated
 * current-user broker transport and verifies the echoed response binding.
 */

import type { BrowserBridgeBrokerTransport } from "./browser-bridge-broker-transport";
import {
  type BrowserBridgeCallerAllowlist,
  type BrowserBridgeNativeCaller,
  BrowserBridgeNativeProtocolError,
  type BrowserBridgeNativeResponse,
  createAuthenticatedBrokerEnvelope,
  parseNativeEnrollmentRequest,
  parseNativeEnrollmentResponse,
} from "./browser-bridge-native-protocol";

export class BrowserBridgeNativeHost {
  constructor(
    private readonly options: {
      launchedCaller: BrowserBridgeNativeCaller;
      allowlist: BrowserBridgeCallerAllowlist;
      brokerSecret: Uint8Array;
      transport: BrowserBridgeBrokerTransport;
      now?: () => number;
    },
  ) {}

  async handle(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserBridgeNativeResponse> {
    const request = parseNativeEnrollmentRequest(input);
    const envelope = createAuthenticatedBrokerEnvelope({
      request,
      launchedCaller: this.options.launchedCaller,
      allowlist: this.options.allowlist,
      secret: this.options.brokerSecret,
      timestampMs: this.options.now?.(),
    });
    const bytes = await this.options.transport.request(
      Buffer.from(JSON.stringify(envelope), "utf8"),
      signal,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (cause) {
      // error-policy:J3 broker bytes are untrusted until strict response validation succeeds.
      throw new BrowserBridgeNativeProtocolError(
        "invalid_response",
        cause instanceof Error
          ? `broker response JSON is invalid: ${cause.message}`
          : "broker response JSON is invalid",
      );
    }
    const response = parseNativeEnrollmentResponse(decoded);
    if (
      response.requestId !== request.requestId ||
      (response.type === "browser_bridge.enroll_result" &&
        response.nonce !== request.nonce)
    ) {
      throw new BrowserBridgeNativeProtocolError(
        "response_binding_mismatch",
        "broker response does not match the enrollment request",
      );
    }
    return response;
  }
}
