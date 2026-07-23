/**
 * Live publication join between a local project binding and its Cloud record.
 *
 * The local registry stores only `cloudAppId`; every visible status is derived
 * from current Cloud app and deployment data so stale, failed, unpublished, and
 * genuinely live publications remain distinguishable.
 */

import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import { ApiError } from "../../lib/api-client";
import type { App } from "./apps";
import { getApp } from "./apps";
import { listFrontendDeployments } from "./frontend-hosting";

const PROJECT_PUBLICATION_CHANGED_EVENT = "project-publication-changed";

export type ProjectPublicationStatus =
  | "disconnected"
  | "unbound"
  | "loading"
  | "published"
  | "unpublished"
  | "error";

export interface ProjectPublicationSnapshot {
  status: ProjectPublicationStatus;
  app?: App;
  publicUrl?: string;
  activeDeploymentId?: string;
  liveMode?: "managed-frontend" | "container" | "external";
  error?: string;
  staleBinding?: boolean;
}

export interface ProjectPublicationDependencies {
  readApp: typeof getApp;
  listFrontend: typeof listFrontendDeployments;
}

const defaultDependencies: ProjectPublicationDependencies = {
  readApp: getApp,
  listFrontend: listFrontendDeployments,
};

function cleanPublicationUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname === "pending.invalid" ||
      parsed.hostname === "placeholder.invalid"
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // error-policy:J3 malformed Cloud URL is an explicit non-live signal.
    return null;
  }
}

/** Only a definite Cloud 404 proves that the local binding is stale. */
export function isStaleProjectBindingError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function initialSnapshot(
  project: Pick<ProjectSummary, "cloudAppId">,
  cloudConnected: boolean,
): ProjectPublicationSnapshot {
  if (!cloudConnected) return { status: "disconnected" };
  if (!project.cloudAppId) return { status: "unbound" };
  return { status: "loading" };
}

/**
 * Resolve the publication from authoritative Cloud reads.
 *
 * `is_active` alone is not enough to render a usable publication URL. Managed
 * hosting needs an active deployment, containers need a deployed production
 * URL, and intentionally external projects use their validated `app_url`.
 */
export async function loadProjectPublication(
  cloudAppId: string,
  dependencies: ProjectPublicationDependencies = defaultDependencies,
): Promise<ProjectPublicationSnapshot> {
  const [app, frontend] = await Promise.all([
    dependencies.readApp(cloudAppId),
    dependencies.listFrontend(cloudAppId),
  ]);
  const managedUrl = cleanPublicationUrl(frontend.public_url);
  const containerUrl = cleanPublicationUrl(app.production_url);
  const configuredAppUrl = cleanPublicationUrl(app.app_url);
  const activeFrontend = frontend.active_deployment_id
    ? frontend.deployments.find(
        (deployment) =>
          deployment.id === frontend.active_deployment_id &&
          deployment.status === "active",
      )
    : undefined;
  const managedFrontendLive = Boolean(activeFrontend && managedUrl);
  const containerLive = Boolean(
    app.deployment_status === "deployed" && containerUrl,
  );
  const externalUrl =
    configuredAppUrl &&
    configuredAppUrl !== managedUrl &&
    configuredAppUrl !== containerUrl
      ? configuredAppUrl
      : null;
  const liveMode = managedFrontendLive
    ? "managed-frontend"
    : containerLive
      ? "container"
      : externalUrl
        ? "external"
        : undefined;
  const publicUrl =
    liveMode === "managed-frontend"
      ? (managedUrl ?? undefined)
      : liveMode === "container"
        ? (containerUrl ?? undefined)
        : liveMode === "external"
          ? (externalUrl ?? undefined)
          : (managedUrl ?? containerUrl ?? externalUrl ?? undefined);

  if (app.is_active && !liveMode) {
    return {
      status: "error",
      app,
      error:
        "The Cloud record is active, but it has no valid managed, container, or external publication URL.",
      ...(publicUrl ? { publicUrl } : {}),
    };
  }

  return {
    status: app.is_active && liveMode ? "published" : "unpublished",
    app,
    ...(publicUrl ? { publicUrl } : {}),
    ...(frontend.active_deployment_id
      ? { activeDeploymentId: frontend.active_deployment_id }
      : {}),
    ...(liveMode ? { liveMode } : {}),
  };
}

/** Tell all project cards and panels to re-read Cloud publication state. */
export function notifyProjectPublicationChanged(projectId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(PROJECT_PUBLICATION_CHANGED_EVENT, {
      detail: { projectId },
    }),
  );
}

/** Reactive live publication state with explicit loading/error outcomes. */
export function useProjectPublication(
  project: Pick<ProjectSummary, "id" | "cloudAppId">,
  cloudConnected: boolean,
): ProjectPublicationSnapshot & { refresh: () => void } {
  const [snapshot, setSnapshot] = useState<ProjectPublicationSnapshot>(() =>
    initialSnapshot(project, cloudConnected),
  );
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === project.id) refresh();
    };
    window.addEventListener(PROJECT_PUBLICATION_CHANGED_EVENT, handleChange);
    return () =>
      window.removeEventListener(
        PROJECT_PUBLICATION_CHANGED_EVENT,
        handleChange,
      );
  }, [project.id, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit retry token.
  useEffect(() => {
    if (!cloudConnected) {
      setSnapshot({ status: "disconnected" });
      return;
    }
    if (!project.cloudAppId) {
      setSnapshot({ status: "unbound" });
      return;
    }

    let current = true;
    setSnapshot({ status: "loading" });
    void loadProjectPublication(project.cloudAppId)
      .then((next) => {
        if (current) setSnapshot(next);
      })
      .catch((error: unknown) => {
        // error-policy:J4 publication failures render a distinct card/panel error.
        if (!current) return;
        setSnapshot({
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Could not load publication state",
          ...(isStaleProjectBindingError(error) ? { staleBinding: true } : {}),
        });
      });
    return () => {
      current = false;
    };
  }, [cloudConnected, project.cloudAppId, revision]);

  return { ...snapshot, refresh };
}
