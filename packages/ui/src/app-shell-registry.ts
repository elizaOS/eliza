/**
 * Owns app-shell page registration and the generated in-process agent-bridge
 * inventory shared with overlay-app renderers. Plugins contribute metadata;
 * the shell derives stable bridge owners from the live registry snapshots and
 * rejects ambiguous handler ids before mounting either surface family.
 */

import { packageNameToAppRouteSlug } from "@elizaos/core/protocol";
import type { AppShellPageRegistration } from "./app-shell-pages.js";
import { listAppShellPages } from "./app-shell-pages.js";
import type { OverlayApp } from "./apps/overlay-app-api.js";
import { getAllOverlayApps } from "./apps/overlay-app-registry.js";

export * from "./app-shell-pages.js";
export type RegisteredAgentSurfaceKind = "app-shell" | "overlay";
export interface RegisteredAgentSurfaceDescriptor {
  kind: RegisteredAgentSurfaceKind;
  viewId: string;
  ownerId: string;
  path: string;
}
function requireStableAgentViewId(
  value: string,
  kind: RegisteredAgentSurfaceKind,
  ownerId: string,
): string {
  const viewId = value.trim();
  if (viewId.length === 0) {
    throw new Error(
      `Registered ${kind} surface "${ownerId}" resolved an empty agent view id`,
    );
  }
  return viewId;
}
function overlayAgentViewId(appName: string): string {
  const packageSlug = packageNameToAppRouteSlug(appName);
  if (packageSlug) return packageSlug;
  return appName
    .replace(/^@[^/]+\//, "")
    .replace(/^(app|plugin)-/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}
/** The bridge descriptor generated for one app-shell page registration. */
export function appShellAgentSurfaceDescriptor(
  page: AppShellPageRegistration,
): RegisteredAgentSurfaceDescriptor {
  return {
    kind: "app-shell",
    viewId: requireStableAgentViewId(
      page.agentViewId ?? page.id,
      "app-shell",
      page.pluginId,
    ),
    ownerId: page.pluginId,
    path: page.path,
  };
}
/** The bridge descriptor generated for one overlay-app registration. */
export function overlayAgentSurfaceDescriptor(
  app: OverlayApp,
): RegisteredAgentSurfaceDescriptor {
  const viewId = requireStableAgentViewId(
    overlayAgentViewId(app.name),
    "overlay",
    app.name,
  );
  return {
    kind: "overlay",
    viewId,
    ownerId: app.name,
    path: `/apps/${viewId}`,
  };
}
/**
 * Build the exhaustive in-process bridge inventory from registry snapshots.
 * Duplicate identities fail closed: two mounted surfaces cannot safely share
 * one `viewType:viewId` interact-handler key.
 */
export function buildRegisteredAgentSurfaceInventory(
  appShellPages: readonly AppShellPageRegistration[],
  overlayApps: readonly OverlayApp[],
): RegisteredAgentSurfaceDescriptor[] {
  const descriptors = [
    ...appShellPages.map(appShellAgentSurfaceDescriptor),
    ...overlayApps.map(overlayAgentSurfaceDescriptor),
  ];
  const ownersByViewId = new Map<string, RegisteredAgentSurfaceDescriptor>();
  for (const descriptor of descriptors) {
    const existing = ownersByViewId.get(descriptor.viewId);
    if (existing) {
      throw new Error(
        `Agent surface view id "${descriptor.viewId}" is registered by both ` +
          `${existing.kind}:${existing.ownerId} and ${descriptor.kind}:${descriptor.ownerId}`,
      );
    }
    ownersByViewId.set(descriptor.viewId, descriptor);
  }
  return descriptors.sort((left, right) =>
    left.viewId.localeCompare(right.viewId),
  );
}
/** The current exhaustive bridge inventory, generated from both registries. */
export function listRegisteredAgentSurfaceInventory(): RegisteredAgentSurfaceDescriptor[] {
  return buildRegisteredAgentSurfaceInventory(
    listAppShellPages(),
    getAllOverlayApps(),
  );
}
/**
 * Resolve a renderer's descriptor through the exhaustive live inventory. This
 * makes duplicate-id validation part of the mount path, not a test-only audit.
 */
export function requireRegisteredAgentSurface(
  expected: RegisteredAgentSurfaceDescriptor,
): RegisteredAgentSurfaceDescriptor {
  const descriptor = listRegisteredAgentSurfaceInventory().find(
    (candidate) =>
      candidate.kind === expected.kind &&
      candidate.viewId === expected.viewId &&
      candidate.ownerId === expected.ownerId,
  );
  if (!descriptor) {
    throw new Error(
      `Agent surface ${expected.kind}:${expected.viewId} is not present in the live registry inventory`,
    );
  }
  return descriptor;
}
/**
 * A thunk that resolves a host-provided module for view bundles. View bundles
 * are built with `@elizaos/ui`, `react`, etc. left external; at runtime the
 * shell resolves each external specifier to the host's own singleton through
 * this importer so the view shares the host realm.
 */
export type HostExternalImporter = () => Promise<Record<string, unknown>>;
function hostExternalImporterRegistryKey(): symbol {
  return Symbol.for("elizaos.app.host-external-importer-registry");
}
function getHostExternalImporterStore(): Map<string, HostExternalImporter> {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const registryKey = hostExternalImporterRegistryKey();
  const existing = globalObject[registryKey] as
    | Map<string, HostExternalImporter>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, HostExternalImporter>();
  globalObject[registryKey] = created;
  return created;
}
/**
 * Contribute a host-external importer for a view-bundle specifier the framework
 * trunk map in `DynamicViewLoader` does not own. This is the extension point
 * that keeps plugin-specific specifiers (e.g. `@elizaos/plugin-browser`) out of
 * the shared UI trunk: a plugin app-shell bundle or a build-variant entrypoint
 * registers its own specifiers, and `DynamicViewLoader` consults this registry
 * after its framework map. Backed by a global-symbol store so a single registry
 * is shared even if `@elizaos/ui` is instantiated in more than one chunk.
 */
export function registerHostExternalImporter(
  specifier: string,
  importer: HostExternalImporter,
): void {
  getHostExternalImporterStore().set(specifier, importer);
}
/** Resolve a registered host-external importer, or `undefined` if none. */
export function resolveRegisteredHostExternalImporter(
  specifier: string,
): HostExternalImporter | undefined {
  return getHostExternalImporterStore().get(specifier);
}
/** The specifiers contributed through {@link registerHostExternalImporter}. */
export function registeredHostExternalSpecifiers(): string[] {
  return [...getHostExternalImporterStore().keys()];
}
