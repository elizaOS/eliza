/**
 * Browser capability gate for Steward web passkeys.
 *
 * The embedded native WebView cannot use Steward's browser WebAuthn path unless
 * a native bridge supplies it. Regular browsers still get passkeys, but only
 * after the platform authenticator probe succeeds; until then the login page
 * must present non-passkey options.
 */

type CapacitorLike = {
  isNativePlatform?: () => boolean;
};

export type WebPasskeyCapability = {
  usable: boolean;
  reason:
    | "available"
    | "native-without-bridge"
    | "insecure-context"
    | "missing-credentials-api"
    | "missing-public-key-credential"
    | "platform-authenticator-unavailable"
    | "platform-authenticator-probe-failed";
};

export type WebPasskeyCapabilityEnvironment = {
  isSecureContext?: boolean;
  navigator?: {
    credentials?: {
      get?: unknown;
      create?: unknown;
    };
  };
  publicKeyCredential?: Pick<
    typeof PublicKeyCredential,
    "isUserVerifyingPlatformAuthenticatorAvailable"
  >;
  capacitor?: CapacitorLike;
};

function isNativeRuntime(capacitor: CapacitorLike | undefined): boolean {
  return Boolean(capacitor?.isNativePlatform?.());
}

function resolveDefaultEnvironment(): WebPasskeyCapabilityEnvironment {
  const globalWithRuntime = globalThis as typeof globalThis & {
    Capacitor?: CapacitorLike;
  };
  return {
    isSecureContext: globalThis.isSecureContext,
    navigator: typeof navigator === "undefined" ? undefined : navigator,
    publicKeyCredential:
      typeof PublicKeyCredential === "undefined"
        ? undefined
        : PublicKeyCredential,
    capacitor: globalWithRuntime.Capacitor,
  };
}

/**
 * Resolve whether the current browser can genuinely complete Steward's web
 * passkey calls. This is async because UVPAA is the browser-owned truth for
 * user-verifying platform authenticators.
 */
export async function resolveWebPasskeyCapability(
  env: WebPasskeyCapabilityEnvironment = resolveDefaultEnvironment(),
): Promise<WebPasskeyCapability> {
  // The shipped Capacitor app has no native WebAuthn / Credential Manager
  // bridge. Fail closed even when the embedded WebView exposes partial browser
  // APIs: calling Steward's navigator.credentials path there cannot complete.
  if (isNativeRuntime(env.capacitor)) {
    return { usable: false, reason: "native-without-bridge" };
  }
  if (env.isSecureContext !== true) {
    return { usable: false, reason: "insecure-context" };
  }
  if (
    typeof env.navigator?.credentials?.get !== "function" ||
    typeof env.navigator.credentials.create !== "function"
  ) {
    return { usable: false, reason: "missing-credentials-api" };
  }
  const probe =
    env.publicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof probe !== "function") {
    return { usable: false, reason: "missing-public-key-credential" };
  }

  try {
    const available = await probe.call(env.publicKeyCredential);
    return available
      ? { usable: true, reason: "available" }
      : {
          usable: false,
          reason: "platform-authenticator-unavailable",
        };
  } catch {
    // error-policy:J4 A rejected browser capability probe is an expected,
    // visibly unavailable login state; it must never enable the passkey path.
    return { usable: false, reason: "platform-authenticator-probe-failed" };
  }
}
