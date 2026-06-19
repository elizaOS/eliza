import { normalizeCloudSiteUrl } from "@elizaos/shared";

export const HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM = "homeRemoteRunnerSession";

export interface HomeRemoteRunnerSshTunnel {
  command: string;
  localUrl: string;
}

export function buildHomeRemoteRunnerAccessUrl(input: {
  cloudBaseUrl?: string | null;
  sessionId?: string | null;
}): string | null {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return null;

  try {
    const url = new URL(normalizeCloudSiteUrl(input.cloudBaseUrl ?? undefined));
    url.pathname = "/dashboard/app";
    url.search = "";
    url.hash = "";
    url.searchParams.set(HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM, sessionId);
    return url.toString();
  } catch {
    return null;
  }
}

export function buildHomeRemoteRunnerSshTunnel(input: {
  remoteBaseUrl?: string | null;
  sshTarget?: string | null;
  sshIdentity?: string | null;
  localPort?: string | number | null;
}): HomeRemoteRunnerSshTunnel | null {
  const sshTarget = normalizeSshTarget(input.sshTarget);
  if (!sshTarget) return null;

  let parsed: URL;
  try {
    parsed = new URL(input.remoteBaseUrl?.trim() ?? "");
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:") {
    return null;
  }

  const remotePort = parsed.port || "80";
  const localPort = normalizePort(input.localPort) ?? remotePort;
  const remoteHost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
      ? "127.0.0.1"
      : parsed.hostname;
  const identityArg = input.sshIdentity?.trim()
    ? ` -i ${quoteShellArg(input.sshIdentity.trim())}`
    : "";
  const command = `ssh -N${identityArg} -L 127.0.0.1:${localPort}:${remoteHost}:${remotePort} ${sshTarget}`;
  return {
    command,
    localUrl: `${parsed.protocol}//127.0.0.1:${localPort}`,
  };
}

function normalizePort(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return String(port);
}

function normalizeSshTarget(value: string | null | undefined): string | null {
  const target = value?.trim();
  if (!target) return null;
  if (!/^[A-Za-z0-9._~%+-]+@[A-Za-z0-9.-]+$/.test(target)) return null;
  return target;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
