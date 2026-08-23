/** Declares the shared Chrome identity verifier for TypeScript packaging callers. */

export interface ChromeExtensionIdentityInput {
  chromeDevManifestKey: string;
  chromeDevExtensionId: string;
}

export interface ResolvedChromeExtensionIdentity {
  extensionId: string;
  manifestKey: string;
  authority: "local_dev" | "chrome_web_store";
}

export function deriveChromeExtensionId(manifestKey: string): string;

export function resolveChromeExtensionIdentity(options: {
  identity: ChromeExtensionIdentityInput;
  release: boolean;
  env?: NodeJS.ProcessEnv;
}): ResolvedChromeExtensionIdentity;
