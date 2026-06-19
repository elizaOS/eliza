const DEFAULT_PAIRING_PORT = "2138";
const PAIRING_CODE_PATH = "/api/auth/pair-code";
const PLACEHOLDER_SSH_TARGET = "user@your-server";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export interface PairingCodeCommandInfo {
  serverCommand: string;
  sshCommand: string | null;
  sshTarget: string | null;
  usesDefaultPort: boolean;
  isLoopback: boolean;
}

function parseRemoteUrlInput(value: string | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function formatSshTarget(hostname: string): string {
  const host = normalizeHostname(hostname);
  return `user@${host.includes(":") ? `[${host}]` : host}`;
}

export function buildPairingCodeCommandInfo(
  remoteUrl?: string,
): PairingCodeCommandInfo {
  const parsed = parseRemoteUrlInput(remoteUrl);
  const hostname = parsed ? normalizeHostname(parsed.hostname) : "";
  const port = parsed?.port || DEFAULT_PAIRING_PORT;
  const serverCommand = `curl -s http://127.0.0.1:${port}${PAIRING_CODE_PATH}`;
  const isLoopback = Boolean(hostname && LOOPBACK_HOSTS.has(hostname));
  const sshTarget = !isLoopback
    ? parsed
      ? formatSshTarget(parsed.hostname)
      : PLACEHOLDER_SSH_TARGET
    : null;

  return {
    serverCommand,
    sshCommand: sshTarget ? `ssh ${sshTarget} "${serverCommand}"` : null,
    sshTarget,
    usesDefaultPort: !parsed?.port,
    isLoopback,
  };
}
