/**
 * Renderer adapter for fingerprint inspection and native SSH tunnels. Only the
 * removed Electrobun desktop host provided the tunnel, so no host serves these
 * requests now: they fail with an explicit unsupported error.
 */

const SSH_RUNTIME_UNSUPPORTED = "SSH runtimes are not supported in this app.";

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

export interface SshRuntimeStatus {
  running: boolean;
  localPort: number | null;
  startedAt: number | null;
  reconnectState: "stopped" | "running" | "blocked";
  lastError: string | null;
}

export async function inspectSshHost(_input: {
  runtimeId: string;
  target: string;
  sshPort: number;
}): Promise<SshHostInspection> {
  throw new Error(SSH_RUNTIME_UNSUPPORTED);
}

export async function startSshRuntime(
  _input: SshRuntimeEnrollment,
): Promise<{ apiBase: string; localPort: number; fingerprint: string }> {
  throw new Error(SSH_RUNTIME_UNSUPPORTED);
}

export async function stopSshRuntime(_runtimeId: string): Promise<boolean> {
  return false;
}

export async function getSshRuntimeStatus(
  _runtimeId: string,
): Promise<SshRuntimeStatus> {
  return {
    running: false,
    localPort: null,
    startedAt: null,
    reconnectState: "stopped",
    lastError: null,
  };
}

export async function requestSshRuntime(_input: {
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
  throw new Error(SSH_RUNTIME_UNSUPPORTED);
}
