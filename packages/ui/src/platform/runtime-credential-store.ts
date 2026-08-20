/**
 * Runtime credential storage for renderer callers. Desktop delegates durable
 * persistence to the main-process OS keychain. Plain web keeps credentials in
 * memory for the current session and never writes them to browser storage.
 */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { getNativePlugin } from "../bridge/native-plugins";

const sessionCredentials = new Map<string, string>();

interface NativeRuntimeCredentialPlugin extends Record<string, unknown> {
  storeRuntimeCredential?: (input: {
    runtimeId: string;
    token: string;
  }) => Promise<{ stored: true }>;
  loadRuntimeCredential?: (input: {
    runtimeId: string;
  }) => Promise<{ token: string | null }>;
  deleteRuntimeCredential?: (input: {
    runtimeId: string;
  }) => Promise<{ deleted: true }>;
}

export async function storeRuntimeCredential(
  runtimeId: string,
  token: string,
): Promise<"secure" | "session"> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Runtime credential cannot be empty");
  sessionCredentials.set(runtimeId, trimmed);
  const native = getNativePlugin<NativeRuntimeCredentialPlugin>("ElizaIntent");
  if (typeof native.storeRuntimeCredential === "function") {
    const result = await native.storeRuntimeCredential({
      runtimeId,
      token: trimmed,
    });
    if (result.stored) return "secure";
  }
  const result = await invokeDesktopBridgeRequest<{ stored: true }>({
    rpcMethod: "desktopStoreRuntimeCredential",
    ipcChannel: "desktop:storeRuntimeCredential",
    params: { runtimeId, token: trimmed },
  });
  return result?.stored ? "secure" : "session";
}

export async function loadRuntimeCredential(
  runtimeId: string,
): Promise<string | null> {
  const cached = sessionCredentials.get(runtimeId);
  if (cached) return cached;
  const native = getNativePlugin<NativeRuntimeCredentialPlugin>("ElizaIntent");
  if (typeof native.loadRuntimeCredential === "function") {
    const result = await native.loadRuntimeCredential({ runtimeId });
    if (result.token) sessionCredentials.set(runtimeId, result.token);
    return result.token;
  }
  const result = await invokeDesktopBridgeRequest<{ token: string | null }>({
    rpcMethod: "desktopLoadRuntimeCredential",
    ipcChannel: "desktop:loadRuntimeCredential",
    params: { runtimeId },
  });
  if (result?.token) sessionCredentials.set(runtimeId, result.token);
  return result?.token ?? null;
}

export async function deleteRuntimeCredential(
  runtimeId: string,
): Promise<void> {
  sessionCredentials.delete(runtimeId);
  const native = getNativePlugin<NativeRuntimeCredentialPlugin>("ElizaIntent");
  if (typeof native.deleteRuntimeCredential === "function") {
    await native.deleteRuntimeCredential({ runtimeId });
    return;
  }
  await invokeDesktopBridgeRequest<{ deleted: true }>({
    rpcMethod: "desktopDeleteRuntimeCredential",
    ipcChannel: "desktop:deleteRuntimeCredential",
    params: { runtimeId },
  });
}
