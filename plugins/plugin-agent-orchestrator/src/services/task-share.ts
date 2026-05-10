import { readFileSync } from "node:fs";
import path from "node:path";
import { getElizaNamespace, resolveStateDir, resolveUserPath } from "@elizaos/core";
import { extractDevServerUrl } from "./ansi-utils.js";
import type { SwarmCoordinator } from "./swarm-coordinator.js";
import type { TaskArtifactRecord, TaskThreadDetail } from "./task-registry.js";

export type TaskShareTargetType =
  | "artifact_uri"
  | "artifact_path"
  | "preview_url"
  | "workspace";

export interface TaskShareTarget {
  type: TaskShareTargetType;
  label: string;
  value: string;
  source: string;
  remoteAccessible: boolean;
}

export interface TaskShareDiscovery {
  threadId: string;
  title: string;
  shareCapabilities: string[];
  preferredTarget: TaskShareTarget | null;
  targets: TaskShareTarget[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function resolveConfigPath(): string {
  const explicit = process.env.ELIZA_CONFIG_PATH?.trim();
  if (explicit) return resolveUserPath(explicit);

  const namespace = getElizaNamespace();
  const filename = namespace === "eliza" ? "eliza.json" : `${namespace}.json`;
  return path.join(resolveStateDir(), filename);
}

function readElizaConfig(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(resolveConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function detectShareCapabilities(): string[] {
  const config = readElizaConfig();
  const capabilities: string[] = [];
  const gateway =
    config && typeof config.gateway === "object" && config.gateway
      ? (config.gateway as Record<string, unknown>)
      : null;
  const gatewayTailscale =
    gateway && typeof gateway.tailscale === "object" && gateway.tailscale
      ? (gateway.tailscale as Record<string, unknown>)
      : null;
  const gatewayRemote =
    gateway && typeof gateway.remote === "object" && gateway.remote
      ? (gateway.remote as Record<string, unknown>)
      : null;

  const tailscaleMode =
    typeof gatewayTailscale?.mode === "string" ? gatewayTailscale.mode : null;
  if (tailscaleMode && tailscaleMode !== "off") {
    capabilities.push(`tailscale:${tailscaleMode}`);
  }
  if (typeof gatewayRemote?.url === "string" && gatewayRemote.url.trim()) {
    capabilities.push("gateway-remote-url");
  }
  if (
    typeof gatewayRemote?.sshTarget === "string" &&
    gatewayRemote.sshTarget.trim()
  ) {
    capabilities.push("gateway-remote-ssh");
  }
  return capabilities;
}

function isRemoteAccessibleUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.trim().toLowerCase();
    return !["localhost", "127.0.0.1", "0.0.0.0"].includes(host);
  } catch {
    return false;
  }
}

function pushTarget(
  targets: TaskShareTarget[],
  seen: Set<string>,
  target: TaskShareTarget,
): void {
  const key = `${target.type}:${target.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

function artifactTargets(
  artifacts: TaskArtifactRecord[],
  targets: TaskShareTarget[],
  seen: Set<string>,
): void {
  for (const artifact of artifacts) {
    if (artifact.uri?.trim()) {
      pushTarget(targets, seen, {
        type: "artifact_uri",
        label: artifact.title,
        value: artifact.uri,
        source: `artifact:${artifact.artifactType}`,
        remoteAccessible: isRemoteAccessibleUrl(artifact.uri),
      });
    }
    if (artifact.path?.trim()) {
      pushTarget(targets, seen, {
        type: "artifact_path",
        label: artifact.title,
        value: artifact.path,
        source: `artifact:${artifact.artifactType}`,
        remoteAccessible: false,
      });
    }
  }
}

function transcriptTargets(
  thread: TaskThreadDetail,
  targets: TaskShareTarget[],
  seen: Set<string>,
): void {
  const recentTranscript = (thread.transcripts ?? [])
    .slice(-100)
    .map((entry) => entry.content)
    .join("\n");
  const previewUrl = extractDevServerUrl(recentTranscript);
  if (previewUrl) {
    pushTarget(targets, seen, {
      type: "preview_url",
      label: "Live preview",
      value: previewUrl,
      source: "transcript:dev-server",
      remoteAccessible: isRemoteAccessibleUrl(previewUrl),
    });
  }

  const discoveredUrls = recentTranscript.match(URL_RE) ?? [];
  for (const value of discoveredUrls) {
    pushTarget(targets, seen, {
      type: "preview_url",
      label: "Discovered URL",
      value,
      source: "transcript:url",
      remoteAccessible: isRemoteAccessibleUrl(value),
    });
  }
}

function workspaceTargets(
  thread: TaskThreadDetail,
  targets: TaskShareTarget[],
  seen: Set<string>,
): void {
  if (thread.latestWorkdir?.trim()) {
    pushTarget(targets, seen, {
      type: "workspace",
      label: "Workspace",
      value: thread.latestWorkdir,
      source: "thread:latest-workdir",
      remoteAccessible: false,
    });
  }
}

function preferredTarget(targets: TaskShareTarget[]): TaskShareTarget | null {
  const remote = targets.find((target) => target.remoteAccessible);
  if (remote) return remote;
  const preview = targets.find((target) => target.type === "preview_url");
  if (preview) return preview;
  const artifact = targets.find((target) => target.type === "artifact_path");
  if (artifact) return artifact;
  return targets[0] ?? null;
}

export async function discoverTaskShareOptions(
  coordinator: SwarmCoordinator,
  threadId: string,
): Promise<TaskShareDiscovery | null> {
  const thread = await coordinator.getTaskThread(threadId);
  if (!thread) return null;

  const targets: TaskShareTarget[] = [];
  const seen = new Set<string>();
  artifactTargets(thread.artifacts ?? [], targets, seen);
  transcriptTargets(thread, targets, seen);
  workspaceTargets(thread, targets, seen);

  return {
    threadId: thread.id,
    title: thread.title,
    shareCapabilities: detectShareCapabilities(),
    preferredTarget: preferredTarget(targets),
    targets,
  };
}
