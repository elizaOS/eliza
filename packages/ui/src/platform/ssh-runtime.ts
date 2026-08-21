/** Renderer boundary for the desktop-owned SSH-agent tunnel. */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

export interface SshRuntimeEnrollment {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
  credentialRef?: string;
}

export async function startSshRuntime(
  input: SshRuntimeEnrollment,
): Promise<{ apiBase: string; localPort: number }> {
  const result = await invokeDesktopBridgeRequest<{
    apiBase: string;
    localPort: number;
  }>({
    rpcMethod: "desktopStartSshRuntime",
    ipcChannel: "desktop:startSshRuntime",
    params: input,
  });
  if (!result) {
    throw new Error("SSH setup is available in the Eliza desktop app.");
  }
  return result;
}

export async function stopSshRuntime(runtimeId: string): Promise<void> {
  await invokeDesktopBridgeRequest({
    rpcMethod: "desktopStopSshRuntime",
    ipcChannel: "desktop:stopSshRuntime",
    params: { runtimeId },
  });
}

export async function requestSshRuntime(input: {
  runtimeId: string;
  credentialRef?: string;
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}): Promise<{
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
}> {
  const result = await invokeDesktopBridgeRequest<{
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: string | null;
  }>({
    rpcMethod: "desktopSshRuntimeRequest",
    ipcChannel: "desktop:sshRuntimeRequest",
    params: input,
  });
  if (!result) throw new Error("The SSH gateway transport is unavailable.");
  return result;
}
