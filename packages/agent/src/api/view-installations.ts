/** Runtime object ownership for atomic view installations and synchronous revocation. */
import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  bindViewAssets,
  getViewAssetRoot,
  type ViewAssetKind,
} from "./view-assets.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

/** An opaque in-process handle. Serialized IDs never grant installation authority. */
export interface ViewInstallation {
  readonly id: string;
}

type Installation = {
  runtime: IAgentRuntime;
  owner: string;
  packageName: string;
  handle: ViewInstallation;
  state: "pending" | "active" | "revoked";
  entries: Map<string, ViewRegistryEntry>;
};
type Registry = {
  closed: boolean;
  revision: number;
  pending: Map<string, Installation>;
  active: Map<string, Installation>;
};
const registries = new WeakMap<IAgentRuntime, Registry>();
const installations = new WeakMap<ViewInstallation, Installation>();
const entryInstallations = new WeakMap<ViewRegistryEntry, Installation>();

function installationAssetUrl(
  url: string | undefined,
  installationId: string,
  entry: ViewRegistryEntry,
  kind: ViewAssetKind,
): string | undefined {
  if (!url?.startsWith("/api/views/")) return url;
  const parsed = new URL(url, "http://view.local");
  const root = getViewAssetRoot(entry, kind);
  const rootName =
    root?.rootName ?? (kind === "bundle" ? "bundle.js" : "frame.html");
  parsed.pathname = `/api/views/${encodeURIComponent(entry.id)}/installations/${installationId}/${entry.viewType ?? "gui"}/${kind}/${encodeURIComponent(rootName)}`;
  parsed.searchParams.delete("installation");
  parsed.searchParams.delete("viewType");
  return `${parsed.pathname}${parsed.search}`;
}

function registryFor(runtime: IAgentRuntime): Registry {
  let registry = registries.get(runtime);
  if (!registry) {
    registry = {
      closed: false,
      revision: 0,
      pending: new Map(),
      active: new Map(),
    };
    registries.set(runtime, registry);
  }
  return registry;
}
function requireOpen(registry: Registry): void {
  if (registry.closed)
    throw new ElizaError("Runtime view registry is closed", {
      code: "VIEW_REGISTRY_CLOSED",
    });
}
function requireInstallation(
  runtime: IAgentRuntime,
  handle: ViewInstallation,
): Installation {
  const installation = installations.get(handle);
  if (
    !installation ||
    installation.runtime !== runtime ||
    installation.state === "revoked"
  ) {
    throw new ElizaError(
      "View installation is stale or belongs to another runtime",
      { code: "VIEW_INSTALLATION_INVALID" },
    );
  }
  return installation;
}

/** Reserve a new installation without deleting the currently usable one. */
export function beginViewInstallation(
  runtime: IAgentRuntime,
  owner: string,
  packageName = owner,
): ViewInstallation {
  const registry = registryFor(runtime);
  requireOpen(registry);
  const previous = registry.pending.get(owner);
  if (previous) previous.state = "revoked";
  const handle = Object.freeze({ id: randomUUID() });
  const installation: Installation = {
    runtime,
    owner,
    packageName,
    handle,
    state: "pending",
    entries: new Map(),
  };
  registry.pending.set(owner, installation);
  installations.set(handle, installation);
  return handle;
}

/** Validate the entire replacement before publishing any entry. */
export function commitViewInstallation(
  runtime: IAgentRuntime,
  handle: ViewInstallation,
  entries: readonly ViewRegistryEntry[],
): ViewRegistryEntry[] {
  const registry = registryFor(runtime);
  requireOpen(registry);
  const installation = requireInstallation(runtime, handle);
  if (
    installation.state !== "pending" ||
    registry.pending.get(installation.owner) !== installation
  ) {
    throw new ElizaError("View installation is no longer pending", {
      code: "VIEW_INSTALLATION_INVALID",
    });
  }
  const proposed = new Map<string, ViewRegistryEntry>();
  for (const entry of entries) {
    const key = `${entry.viewType}:${entry.id}`;
    if (entry.pluginName !== installation.owner || proposed.has(key)) {
      throw new ElizaError(
        "View installation contains duplicate or mismatched owners",
        { code: "VIEW_REGISTRY_COLLISION" },
      );
    }
    for (const active of registry.active.values()) {
      if (active.owner === installation.owner) continue;
      const incumbent = active.entries.get(key);
      if (
        incumbent &&
        !(
          incumbent.builtin &&
          incumbent.fallbackFor === installation.packageName &&
          incumbent.path === entry.path
        ) &&
        !(
          entry.builtin &&
          entry.fallbackFor === active.packageName &&
          entry.path === incumbent.path
        )
      )
        throw new ElizaError(`View ${entry.id} is already registered`, {
          code: "VIEW_REGISTRY_COLLISION",
        });
    }
    // Published entries are installation-owned snapshots, never caller-owned objects.
    proposed.set(
      key,
      Object.freeze({
        ...entry,
        installationId: handle.id,
        bundleUrl: installationAssetUrl(
          entry.bundleUrl,
          handle.id,
          entry,
          "bundle",
        ),
        bundleUrlVersioned: installationAssetUrl(
          entry.bundleUrlVersioned,
          handle.id,
          entry,
          "bundle",
        ),
        frameUrl: installationAssetUrl(
          entry.frameUrl,
          handle.id,
          entry,
          "frame",
        ),
        frameUrlVersioned: installationAssetUrl(
          entry.frameUrlVersioned,
          handle.id,
          entry,
          "frame",
        ),
      }),
    );
    bindViewAssets(entry, proposed.get(key)!);
  }
  const previous = registry.active.get(installation.owner);
  if (previous) previous.state = "revoked";
  installation.entries = proposed;
  for (const entry of proposed.values())
    entryInstallations.set(entry, installation);
  installation.state = "active";
  registry.pending.delete(installation.owner);
  registry.active.set(installation.owner, installation);
  registry.revision++;
  return [...proposed.values()];
}

/** Revocation is synchronous and cannot remove a newer installation of the same owner. */
export function revokeViewInstallation(
  runtime: IAgentRuntime,
  handle: ViewInstallation,
): void {
  const installation = installations.get(handle);
  if (!installation || installation.runtime !== runtime) return;
  installation.state = "revoked";
  const registry = registryFor(runtime);
  if (registry.pending.get(installation.owner) === installation)
    registry.pending.delete(installation.owner);
  if (registry.active.get(installation.owner) === installation) {
    registry.active.delete(installation.owner);
    registry.revision++;
  }
}

export function assertViewInstallation(
  runtime: IAgentRuntime,
  handle: ViewInstallation,
): void {
  const registry = registryFor(runtime);
  requireOpen(registry);
  const installation = requireInstallation(runtime, handle);
  if (
    installation.state !== "active" ||
    registry.active.get(installation.owner) !== installation
  ) {
    throw new ElizaError("View installation is not active", {
      code: "VIEW_INSTALLATION_INVALID",
    });
  }
}

export function runtimeViewEntries(
  runtime: IAgentRuntime,
): ViewRegistryEntry[] {
  const registry = registryFor(runtime);
  requireOpen(registry);
  const entries = new Map<string, ViewRegistryEntry>();
  for (const installation of registry.active.values()) {
    for (const [key, entry] of installation.entries) {
      const existing = entries.get(key);
      if (!existing || existing.builtin) entries.set(key, entry);
    }
  }
  return [...entries.values()];
}

/** Runtime stop, never ordinary plugin unload or an individual HTTP host's close. */
export function closeRuntimeViewRegistry(runtime: IAgentRuntime): void {
  const registry = registryFor(runtime);
  if (registry.closed) return;
  registry.closed = true;
  for (const installation of [
    ...registry.pending.values(),
    ...registry.active.values(),
  ])
    installation.state = "revoked";
  registry.pending.clear();
  registry.active.clear();
  registry.revision++;
}

/** Bind a retained entry to its actual current in-process installation. */
export function assertRuntimeViewEntry(
  runtime: IAgentRuntime,
  entry: ViewRegistryEntry,
): void {
  const installation = entryInstallations.get(entry);
  if (!installation || installation.runtime !== runtime) {
    throw new ElizaError("View entry has no authority in this runtime", {
      code: "VIEW_INSTALLATION_INVALID",
    });
  }
  assertViewInstallation(runtime, installation.handle);
  if (!runtimeViewEntries(runtime).includes(entry)) {
    throw new ElizaError("View entry is stale or belongs to another runtime", {
      code: "VIEW_INSTALLATION_INVALID",
    });
  }
}
