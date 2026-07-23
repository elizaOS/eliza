/**
 * Live Cloud publication marker for project cards.
 *
 * It renders Published only after the bound Cloud app and hosting deployment
 * prove live; loading and failures remain visually distinct, while unbound and
 * intentionally unpublished projects omit the positive tag.
 */

import { AlertCircle, Loader2 } from "lucide-react";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import { Badge } from "../../../components/ui/badge";
import { useAppSelectorShallow } from "../../../state";
import { useProjectPublication } from "../lib/project-publication";

export function ProjectPublicationBadge({
  project,
  showUnpublished = false,
}: {
  project: Pick<ProjectSummary, "id" | "cloudAppId">;
  showUnpublished?: boolean;
}): React.JSX.Element | null {
  const { connected, t } = useAppSelectorShallow((state) => ({
    connected: state.elizaCloudConnected,
    t: state.t,
  }));
  const publication = useProjectPublication(project, connected);

  if (!project.cloudAppId || publication.status === "disconnected") return null;
  if (publication.status === "loading") {
    return (
      <span
        className="inline-flex items-center gap-1 text-2xs text-muted"
        aria-busy="true"
        data-testid={`project-publication-loading-${project.id}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {t("projects.publish.checkingShort", {
          defaultValue: "Checking",
        })}
      </span>
    );
  }
  if (publication.status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-2xs text-destructive"
        title={publication.error}
        data-testid={`project-publication-error-${project.id}`}
      >
        <AlertCircle className="h-3 w-3" aria-hidden />
        {t("projects.publish.unavailableShort", {
          defaultValue: "Publication unavailable",
        })}
      </span>
    );
  }
  if (publication.status === "published") {
    return (
      <Badge
        variant="outline"
        className="border-status-success/40 bg-status-success-bg text-status-success"
        data-testid={`project-publication-published-${project.id}`}
      >
        {t("projects.publish.published", {
          defaultValue: "Published",
        })}
      </Badge>
    );
  }
  if (showUnpublished && publication.status === "unpublished") {
    return (
      <Badge variant="secondary">
        {t("projects.publish.unpublished", {
          defaultValue: "Unpublished",
        })}
      </Badge>
    );
  }
  return null;
}
