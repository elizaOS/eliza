/** Main-process OS secure-store boundary for renderer runtime credentials. */
import { createNodePlatformSecureStore } from "@elizaos/app-core/security/platform-secure-store-node";
import {
  deleteRemoteRuntimeAccessToken,
  loadRemoteRuntimeAccessToken,
  storeRemoteRuntimeAccessToken,
} from "@elizaos/app-core/security/remote-device-identity";

function readRuntimeId(params: unknown): string {
  if (!params || typeof params !== "object") {
    throw new Error("runtime credential params must be an object");
  }
  const runtimeId = Reflect.get(params, "runtimeId");
  if (
    typeof runtimeId !== "string" ||
    !runtimeId.trim() ||
    runtimeId.length > 256
  ) {
    throw new Error("runtimeId must be a non-empty string");
  }
  return runtimeId.trim();
}

export async function desktopStoreRuntimeCredential(
  params: unknown,
): Promise<{ stored: true }> {
  const runtimeId = readRuntimeId(params);
  const token = Reflect.get(params as object, "token");
  if (typeof token !== "string" || !token.trim() || token.length > 65_536) {
    throw new Error("token must be a non-empty bounded string");
  }
  await storeRemoteRuntimeAccessToken(
    createNodePlatformSecureStore(),
    runtimeId,
    token.trim(),
  );
  return { stored: true };
}

export async function desktopLoadRuntimeCredential(
  params: unknown,
): Promise<{ token: string | null }> {
  return {
    token: await loadRemoteRuntimeAccessToken(
      createNodePlatformSecureStore(),
      readRuntimeId(params),
    ),
  };
}

export async function desktopDeleteRuntimeCredential(
  params: unknown,
): Promise<{ deleted: true }> {
  await deleteRemoteRuntimeAccessToken(
    createNodePlatformSecureStore(),
    readRuntimeId(params),
  );
  return { deleted: true };
}
