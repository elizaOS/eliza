import {
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  type MobileRuntimeMode,
} from "../onboarding/mobile-runtime-mode";
import type { PersistedActiveServer } from "./persistence";

export type AgentRuntimeTargetKind = "local" | "cloud" | "remote";

export interface AgentRuntimeTarget {
  kind: AgentRuntimeTargetKind;
  label: string;
}

function normalizeApiBase(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end -= 1;
  return trimmed.slice(0, end);
}

export function isLocalAgentApiBase(value: string | null | undefined): boolean {
  const apiBase = normalizeApiBase(value);
  if (!apiBase) return false;
  if (apiBase === MOBILE_LOCAL_AGENT_API_BASE) return true;
  try {
    const url = new URL(apiBase);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isCloudMobileMode(mode: MobileRuntimeMode | null): boolean {
  return mode === "cloud" || mode === "cloud-hybrid";
}

function isLocalActiveServer(server: PersistedActiveServer | null): boolean {
  if (!server) return false;
  return (
    server.kind === "local" ||
    server.id.startsWith("local:") ||
    server.label === MOBILE_LOCAL_AGENT_LABEL ||
    isLocalAgentApiBase(server.apiBase)
  );
}

export function inferAgentRuntimeTarget(args: {
  activeServer: PersistedActiveServer | null;
  mobileRuntimeMode: MobileRuntimeMode | null;
  clientBaseUrl?: string | null;
}): AgentRuntimeTarget {
  const { activeServer, mobileRuntimeMode } = args;
  const label = activeServer?.label?.trim();

  if (activeServer?.kind === "cloud" || isCloudMobileMode(mobileRuntimeMode)) {
    return { kind: "cloud", label: label || "Cloud agent" };
  }

  if (
    mobileRuntimeMode === "local" ||
    isLocalActiveServer(activeServer) ||
    isLocalAgentApiBase(args.clientBaseUrl)
  ) {
    return { kind: "local", label: label || "Local agent" };
  }

  return { kind: "remote", label: label || "Remote agent" };
}
