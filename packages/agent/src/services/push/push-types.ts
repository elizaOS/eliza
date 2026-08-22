/**
 * Shared types for the remote-push delivery seam (APNs + FCM).
 */

import type { JsonValue } from "@elizaos/core";

/** The user-facing content a single push carries. */
export interface PushMessage {
  /** Notification headline shown by the OS. */
  title: string;
  /** Optional longer body line. */
  body?: string;
  /**
   * Structured custom data delivered alongside the alert so the app can
   * deep-link and dedupe against the in-app notification center. Values are
   * stringified by the FCM transport (FCM `data` is string→string only); APNs
   * carries them as top-level JSON keys.
   */
  data?: Record<string, JsonValue>;
}

/**
 * A push transport (APNs or FCM). `send` resolves on accept and throws on any
 * HTTP/transport failure so the caller can react — in particular, an
 * `PushUnregisteredError` signals the token is dead and should be dropped.
 */
export interface PushProvider {
  /** Stable provider label for logs. */
  readonly name: string;
  /** True only when every required credential is present and well-formed. */
  isConfigured(): boolean;
  /** Deliver one message to one device token. Throws on failure. */
  send(token: string, message: PushMessage): Promise<void>;
}

/**
 * Thrown when a transport reports that a device token is no longer valid
 * (APNs HTTP 410 / reason "Unregistered"; FCM 404 / UNREGISTERED). The caller
 * removes the token from the registry on this error.
 */
export class PushUnregisteredError extends Error {
  constructor(
    public readonly token: string,
    message: string,
  ) {
    super(message);
    this.name = "PushUnregisteredError";
  }
}
