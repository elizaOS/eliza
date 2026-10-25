/**
 * Browser capability gate for Steward web passkeys.
 *
 * The embedded native WebView cannot use Steward's browser WebAuthn path unless
 * a native bridge supplies it. Regular secure browsers get passkeys whenever
 * the WebAuthn credential APIs exist. UVPAA is deliberately not an overall
 * capability gate: it reports only built-in platform authenticators and may be
 * false even when a roaming security key or another passkey transport works.
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
    | "missing-public-key-credential";
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
 * Resolve whether the current browser can attempt Steward's WebAuthn calls.
 * The platform-authenticator probe is not used here because WebAuthn also
 * supports roaming authenticators; interaction-time browser errors are already
 * translated into actionable recovery by the login state machine.
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
  if (!env.publicKeyCredential) {
    return { usable: false, reason: "missing-public-key-credential" };
  }
  return { usable: true, reason: "available" };
}
