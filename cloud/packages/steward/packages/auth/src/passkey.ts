/**
 * PasskeyAuth — framework-agnostic WebAuthn passkey registration and authentication.
 *
 * Uses @simplewebauthn/server v13. The caller is responsible for persisting
 * credential data returned from verifyRegistration and for looking up credentials
 * (publicKey, counter) when calling verifyAuthentication.
 *
 * Challenges are stored in an in-memory ChallengeStore with a 5-minute TTL.
 * In production you should swap this for a Redis-backed store.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions as swGenAuth,
  generateRegistrationOptions as swGenReg,
  verifyAuthenticationResponse as swVerifyAuth,
  verifyRegistrationResponse as swVerifyReg,
} from "@simplewebauthn/server";

export type {
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

import { ChallengeStore } from "./challenge-store";

// ─── Config ────────────────────────────────────────────────────────────────

export interface PasskeyConfig {
  /** Friendly human-readable name shown in browser dialogs, e.g. "Steward" */
  rpName: string;
  /** Effective domain, e.g. "steward.fi" — must match the browser's origin */
  rpID: string;
  /** Full origin URL, e.g. "https://steward.fi" (or array for multi-origin) */
  origin: string | string[];
  /**
   * Optional external challenge store to share across instances or swap out.
   * Defaults to an isolated ChallengeStore per PasskeyAuth instance.
   */
  challengeStore?: ChallengeStore;
}

// ─── Stored credential shape (what callers persist in their DB) ────────────

export interface StoredCredential {
  /** base64url-encoded credential ID */
  credentialId: string;
  /** base64url-encoded COSE public key */
  credentialPublicKey: string;
  /** Monotonically increasing counter — must be persisted to detect cloning */
  counter: number;
}

// ─── Class ─────────────────────────────────────────────────────────────────

export class PasskeyAuth {
  private readonly config: PasskeyConfig;
  private readonly challenges: ChallengeStore;

  constructor(config: PasskeyConfig) {
    this.config = config;
    this.challenges = config.challengeStore ?? new ChallengeStore();
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Generate options to pass to the browser's `navigator.credentials.create()`.
   *
   * The generated challenge is stored keyed by `userId`. Callers must later
   * call `verifyRegistration` with the same `userId` within 5 minutes.
   *
   * @param userId         Unique user ID (UUID or similar)
   * @param email          User's email (used as the WebAuthn userName)
   * @param existingCredentials  base64url credential IDs already registered for
   *                       this user — prevents duplicate registrations
   */
  async generateRegistrationOptions(
    userId: string,
    email: string,
    existingCredentials: string[] = [],
    options?: {
      /**
       * Hint to the browser about which authenticator to prefer.
       *   - "platform":      built-in (Touch ID, Face ID, Windows Hello)
       *   - "cross-platform": roaming (YubiKey, phone-QR, security key)
       *   - undefined:        let the browser pick (shows both)
       *
       * Most consumer apps want "platform" so the OS surfaces native UX.
       */
      authenticatorAttachment?: "platform" | "cross-platform";
    },
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const regOptions = await swGenReg({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: email,
      userDisplayName: email,
      // Use userId as the WebAuthn userID (as bytes).
      // We slice the underlying ArrayBuffer to get a strict Uint8Array<ArrayBuffer>
      // (TextEncoder returns Uint8Array<ArrayBufferLike> which TS rejects).
      userID: (() => {
        const encoded = new TextEncoder().encode(userId);
        return new Uint8Array(encoded.buffer.slice(0)) as Uint8Array<ArrayBuffer>;
      })(),
      attestationType: "none",
      excludeCredentials: existingCredentials.map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        ...(options?.authenticatorAttachment
          ? { authenticatorAttachment: options.authenticatorAttachment }
          : {}),
      },
    });

    // Store the challenge so we can verify it later
    this.challenges.set(userId, regOptions.challenge);

    return regOptions;
  }

  /**
   * Verify the browser's registration response.
   *
   * Consumes (deletes) the stored challenge — each challenge is one-time-use.
   * On success, persist `registrationInfo.credential` to your database.
   *
   * @param userId            Must match the userId used in generateRegistrationOptions
   * @param response          The JSON response from the browser
   * @param expectedChallenge The challenge that was issued (pass in for explicit verification,
   *                          or omit to auto-consume from the internal store)
   */
  async verifyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    expectedChallenge?: string,
  ) {
    const challenge = expectedChallenge ?? (await this.challenges.consume(userId));
    if (!challenge) {
      throw new Error(
        `No active challenge found for user "${userId}". It may have expired (>5 min) or already been used.`,
      );
    }

    const verification = await swVerifyReg({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
      requireUserVerification: true,
    });

    return verification;
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Generate options to pass to the browser's `navigator.credentials.get()`.
   *
   * The generated challenge is stored keyed by `email`. Callers must call
   * `verifyAuthentication` with the same `email` within 5 minutes.
   *
   * @param email   Used purely as the challenge store key — the browser will
   *                present a discoverable-credential picker if no allowCredentials
   *                list is supplied. Pass `allowCredentials` via options if you
   *                have the user's credentials handy.
   * @param options.allowCredentials  Optionally restrict to known credential IDs
   */
  async generateAuthenticationOptions(
    email: string,
    options?: { allowCredentials?: Array<{ id: string }> },
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const authOptions = await swGenAuth({
      rpID: this.config.rpID,
      userVerification: "preferred",
      allowCredentials: options?.allowCredentials?.map((c) => ({ id: c.id })),
    });

    this.challenges.set(email, authOptions.challenge);

    return authOptions;
  }

  /**
   * Verify the browser's authentication response.
   *
   * Consumes (deletes) the stored challenge. On success, persist the new counter
   * value returned in `authenticationInfo.newCounter` to prevent replay attacks.
   *
   * @param response              The JSON response from the browser
   * @param expectedChallenge     The challenge that was issued (or omit to auto-consume from store)
   * @param credentialPublicKey   base64url-encoded COSE public key (from your DB)
   * @param counter               Current counter value (from your DB)
   * @param email                 Used to look up the stored challenge when expectedChallenge is omitted
   */
  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string | undefined,
    credentialPublicKey: string,
    counter: number,
    email?: string,
  ) {
    // Resolve the challenge
    let challenge: string | null = expectedChallenge ?? null;
    if (!challenge) {
      if (!email) {
        throw new Error(
          "Either expectedChallenge or email must be provided to look up the stored challenge.",
        );
      }
      challenge = await this.challenges.consume(email);
    }
    if (!challenge) {
      throw new Error(
        "No active challenge found. It may have expired (>5 min) or already been used.",
      );
    }

    // Decode the stored base64url public key back to a Uint8Array
    const publicKeyBytes = base64urlToUint8Array(credentialPublicKey);

    const verification = await swVerifyAuth({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
      credential: {
        id: response.id,
        publicKey: publicKeyBytes,
        counter,
      },
      requireUserVerification: true,
    });

    return verification;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a base64url string to Uint8Array<ArrayBuffer>.
 * Works in Node.js / Bun without depending on the browser's atob.
 * Returns a strict Uint8Array<ArrayBuffer> (not ArrayBufferLike) as required by
 * simplewebauthn's type definitions under strict TypeScript.
 */
function base64urlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  // Normalise base64url → standard base64
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  // Use hex as intermediate to avoid TypeScript encoding type issues across @types/node versions
  const hexStr = [...atob(padded)]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  const buf = Buffer.from(hexStr, "hex");
  // Slice to produce a plain ArrayBuffer (not a SharedArrayBuffer slice)
  return new Uint8Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  ) as Uint8Array<ArrayBuffer>;
}

/**
 * Convert a Uint8Array to a base64url string (for persisting public keys).
 */
export function uint8ArrayToBase64url(bytes: Uint8Array): string {
  // Build hex string without Buffer.from(Uint8Array) which has type issues across @types/node versions
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const raw =
    hex
      .match(/.{1,2}/g)
      ?.map((byte) => String.fromCharCode(parseInt(byte, 16)))
      .join("") ?? "";
  const base64 = btoa(raw);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
