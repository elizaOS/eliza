/** Shared native preparation for the mobile entry and development host. */
import { ElizaError } from "@elizaos/core";
import { installProductCharacterHost } from "./install-product-character-host.js";
import { startNativeManagedGoogleHostForBoot } from "./native-managed-google-host.js";
import type { NativeRuntimeProfileStores } from "./native-runtime-profile.js";

export async function prepareNativeRuntimeForBoot(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
  profileStores?: NativeRuntimeProfileStores,
): Promise<{ close(): Promise<void> } | undefined> {
  try {
    await installProductCharacterHost(env);
  } catch (error) {
    // Presentation cannot change the canonical identity or prevent local boot.
    // Only publish the typed code, never an admitted module's arbitrary output.
    const code =
      error instanceof ElizaError &&
      error.code === "NATIVE_RUNTIME_MODULE_UNAVAILABLE"
        ? error.code
        : "NATIVE_PRODUCT_CHARACTER_UNAVAILABLE";
    warn(
      `[product-character] Product presentation is unavailable; the agent keeps its canonical identity (${code}).`,
    );
  }
  // A required Cloud route still fails closed through the existing boot policy.
  return startNativeManagedGoogleHostForBoot(env, warn, profileStores);
}
