/** Renderer boundary for the desktop-owned SSH-agent tunnel. */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

export interface SshRuntimeEnrollment {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
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
