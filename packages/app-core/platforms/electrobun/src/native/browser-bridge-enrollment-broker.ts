/**
 * Composes native-message validation, current-user broker authentication, and
 * the existing owner-authorized browser companion pairing API.
 */

import type { DesktopSession, FetchLike } from "./auth-bridge";
import {
  BrowserBridgePairingError,
  pairBrowserBridgeCompanionAsDesktopOwner,
} from "./browser-bridge-enrollment-adapter";
import {
  authenticateBrokerEnvelope,
  type BrowserBridgeCallerAllowlist,
  type BrowserBridgeNativeEnrollmentResult,
  type BrowserBridgeNativeErrorCode,
  type BrowserBridgeNativeErrorResponse,
  BrowserBridgeNativeProtocolError,
  NATIVE_PAIRING_TOKEN_MAX_TTL_MS,
  NativeEnrollmentReplayGuard,
  parseBrokerEnvelope,
} from "./browser-bridge-native-protocol";

export interface BrowserBridgeEnrollmentBrokerOptions {
  apiBase: string;
  ownerSession: () => Promise<DesktopSession | null>;
  brokerSecret: Uint8Array;
  callerAllowlist: BrowserBridgeCallerAllowlist;
  fetchImpl?: FetchLike;
  now?: () => number;
  replayGuard?: NativeEnrollmentReplayGuard;
}

export type BrowserBridgeEnrollmentBrokerResponse =
  | BrowserBridgeNativeEnrollmentResult
  | BrowserBridgeNativeErrorResponse;

function mapProtocolErrorCode(code: string): BrowserBridgeNativeErrorCode {
  if (code === "unsupported_protocol") return "unsupported_version";
  return "broker_unavailable";
}

export class BrowserBridgeEnrollmentBroker {
  private readonly replayGuard: NativeEnrollmentReplayGuard;

  constructor(private readonly options: BrowserBridgeEnrollmentBrokerOptions) {
    this.replayGuard = options.replayGuard ?? new NativeEnrollmentReplayGuard();
  }

  async handle(input: unknown): Promise<BrowserBridgeEnrollmentBrokerResponse> {
    let requestId: string | null = null;
    try {
      const envelope = parseBrokerEnvelope(input);
      requestId = envelope.request.requestId;
      authenticateBrokerEnvelope(envelope, {
        secret: this.options.brokerSecret,
        allowlist: this.options.callerAllowlist,
        replayGuard: this.replayGuard,
        nowMs: this.options.now?.(),
      });
      const ownerSession = await this.options.ownerSession();
      if (!ownerSession) {
        return {
          v: 1,
          type: "browser_bridge.error",
          requestId,
          code: "app_not_authenticated",
          retryable: true,
        };
      }
      const pairing = await pairBrowserBridgeCompanionAsDesktopOwner({
        apiBase: this.options.apiBase,
        ownerSession,
        payload: {
          browser: envelope.request.browser,
          profileId: envelope.request.profileId,
          extensionVersion: envelope.request.extensionVersion,
        },
        fetchImpl: this.options.fetchImpl,
      });
      if (
        pairing.companion.browser !== envelope.request.browser ||
        pairing.companion.profileId !== envelope.request.profileId
      ) {
        throw new Error(
          "browser pairing response does not match the enrollment request",
        );
      }
      const issuedAtMs = this.options.now?.() ?? Date.now();
      const maximumExpiryMs = issuedAtMs + NATIVE_PAIRING_TOKEN_MAX_TTL_MS;
      const upstreamExpiryMs = pairing.pairingTokenExpiresAt
        ? Date.parse(pairing.pairingTokenExpiresAt)
        : maximumExpiryMs;
      if (
        !Number.isFinite(upstreamExpiryMs) ||
        upstreamExpiryMs <= issuedAtMs
      ) {
        throw new Error("browser pairing token is already expired");
      }
      const pairingTokenExpiresAt = new Date(
        Math.min(upstreamExpiryMs, maximumExpiryMs),
      ).toISOString();
      return {
        v: 1,
        type: "browser_bridge.enroll_result",
        requestId,
        nonce: envelope.request.nonce,
        issuedAt: new Date(issuedAtMs).toISOString(),
        config: {
          apiBaseUrl: this.options.apiBase,
          companionId: pairing.companion.id,
          pairingToken: pairing.pairingToken,
          pairingTokenExpiresAt,
          browser: envelope.request.browser,
          profileId: envelope.request.profileId,
          profileLabel: pairing.companion.profileLabel,
          label: pairing.companion.label,
        },
      };
    } catch (error) {
      // error-policy:J1 native-host failures become a bounded protocol response; secrets are omitted.
      return {
        v: 1,
        type: "browser_bridge.error",
        requestId,
        code:
          error instanceof BrowserBridgeNativeProtocolError
            ? mapProtocolErrorCode(error.code)
            : error instanceof BrowserBridgePairingError
              ? error.code
              : "broker_unavailable",
        retryable:
          !(error instanceof BrowserBridgeNativeProtocolError) &&
          !(
            error instanceof BrowserBridgePairingError &&
            error.code === "revoked"
          ),
      };
    }
  }
}
