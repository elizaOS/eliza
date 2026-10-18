import type { LoginProviders } from "@elizaos/auth";

export type StewardLoginMethod = "google" | "email" | "sms";

/** Presentation only: discovery and its shared cache retain the server's full capabilities. */
export function selectStewardLoginMethods(
  providers: LoginProviders | null,
  allowedMethods?: readonly StewardLoginMethod[],
): LoginProviders | null {
  if (!providers || !allowedMethods) return providers;
  const allowed = new Set(allowedMethods);
  return {
    ...providers,
    email: allowed.has("email") && providers.email,
    sms: allowed.has("sms") && providers.sms === true,
    google: allowed.has("google") && providers.google,
    oauth: allowed.has("google")
      ? providers.oauth.filter((name) => name === "google")
      : [],
    passkey: false,
    siwe: false,
    siws: false,
    discord: false,
    github: false,
    twitter: false,
    telegram: false,
  };
}
