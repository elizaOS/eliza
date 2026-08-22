/** Renderer-safe adapter for fingerprint inspection and native SSH tunnels. */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

export interface SshHostInspection {
  target: string;
  host: string;
  sshPort: number;
  fingerprints: Array<{ algorithm: string; fingerprint: string }>;
  preferredFingerprint: string;
  pinnedFingerprint: string | null;
  changed: boolean;
}

export interface SshRuntimeEnrollment {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  expectedFingerprint: string;
  identityFile?: string;
  credentialRef: string;
}

export async function inspectSshHost(input: {
  runtimeId: string;
  target: string;
  sshPort: number;
}): Promise<SshHostInspection> {
  const result = await invokeDesktopBridgeRequest<SshHostInspection>({
    rpcMethod: "sshRuntimeInspectHost",
    ipcChannel: "sshRuntime:inspectHost",
    params: input,
  });
  if (!result) {
    throw new Error("SSH setup is available in the Eliza desktop app.");
  }
  return result;
}

export async function startSshRuntime(
  input: SshRuntimeEnrollment,
): Promise<{ apiBase: string; localPort: number; fingerprint: string }> {
  const result = await invokeDesktopBridgeRequest<{
    apiBase: string;
    localPort: number;
    fingerprint: string;
  }>({
    rpcMethod: "sshRuntimeStart",
    ipcChannel: "sshRuntime:start",
    params: input,
  });
  if (!result) {
    throw new Error("SSH setup is available in the Eliza desktop app.");
  }
  return result;
}

export async function stopSshRuntime(runtimeId: string): Promise<boolean> {
  const result = await invokeDesktopBridgeRequest<{ stopped: boolean }>({
    rpcMethod: "sshRuntimeStop",
    ipcChannel: "sshRuntime:stop",
    params: { runtimeId },
  });
  return result?.stopped ?? false;
}

export async function getSshRuntimeStatus(runtimeId: string): Promise<{
  running: boolean;
  localPort: number | null;
  startedAt: number | null;
  reconnectState: "stopped" | "running" | "blocked";
  lastError: string | null;
}> {
  const result = await invokeDesktopBridgeRequest<{
    running: boolean;
    localPort: number | null;
    startedAt: number | null;
    reconnectState: "stopped" | "running" | "blocked";
    lastError: string | null;
  }>({
    rpcMethod: "sshRuntimeStatus",
    ipcChannel: "sshRuntime:status",
    params: { runtimeId },
  });
  return (
    result ?? {
      running: false,
      localPort: null,
      startedAt: null,
      reconnectState: "stopped",
      lastError: null,
    }
  );
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
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  const result = await invokeDesktopBridgeRequest<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }>({
    rpcMethod: "sshRuntimeRequest",
    ipcChannel: "sshRuntime:request",
    params: input,
  });
  if (!result) throw new Error("The SSH runtime transport is unavailable.");
  return result;
}
