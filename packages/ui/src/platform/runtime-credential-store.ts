/**
 * Stores remote runtime bearer tokens through the native credential boundary.
 * Desktop keeps durable values in the OS store; unsupported web hosts retain a
 * token in memory for the current tab and never write it to browser storage.
 */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

const sessionCredentials = new Map<string, string>();

function requireRuntimeId(runtimeId: string): string {
  const value = runtimeId.trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error("Runtime id is invalid.");
  }
  return value;
}

export async function storeRuntimeCredential(
  runtimeIdValue: string,
  accessTokenValue: string,
): Promise<"secure" | "session"> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const accessToken = accessTokenValue.trim();
  if (!accessToken) throw new Error("Runtime access token cannot be empty.");
  const result = await invokeDesktopBridgeRequest<{ stored: true }>({
    rpcMethod: "runtimeCredentialStore",
    ipcChannel: "runtimeCredential:store",
    params: { runtimeId, accessToken },
  });
  if (result?.stored) {
    sessionCredentials.delete(runtimeId);
    return "secure";
  }
  sessionCredentials.set(runtimeId, accessToken);
  return "session";
}

export async function deleteRuntimeCredential(
  runtimeIdValue: string,
): Promise<boolean> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const hadSessionCredential = sessionCredentials.delete(runtimeId);
  const result = await invokeDesktopBridgeRequest<{ deleted: boolean }>({
    rpcMethod: "runtimeCredentialDelete",
    ipcChannel: "runtimeCredential:delete",
    params: { runtimeId },
  });
  return result?.deleted ?? hadSessionCredential;
}

export async function deleteRuntimeCredentialRecord(
  runtimeIdValue: string,
): Promise<boolean> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const hadSessionCredential = sessionCredentials.delete(runtimeId);
  const result = await invokeDesktopBridgeRequest<{ deleted: boolean }>({
    rpcMethod: "runtimeCredentialDeleteRecord",
    ipcChannel: "runtimeCredential:deleteRecord",
    params: { runtimeId },
  });
  return result?.deleted ?? hadSessionCredential;
}
