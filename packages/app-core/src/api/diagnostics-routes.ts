import {
  type DiagnosticsRouteContext as AutonomousDiagnosticsRouteContext,
  handleDiagnosticsRoutes as handleAutonomousDiagnosticsRoutes,
} from "@elizaos/agent/api/diagnostics-routes";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "@elizaos/agent/security/audit-log";

type DiagnosticsRouteContext = Omit<
  AutonomousDiagnosticsRouteContext,
  | "auditEventTypes"
  | "auditSeverities"
  | "getAuditFeedSize"
  | "queryAuditFeed"
  | "subscribeAuditFeed"
>;

export async function handleDiagnosticsRoutes(
  ctx: DiagnosticsRouteContext,
): Promise<boolean> {
  return handleAutonomousDiagnosticsRoutes({
    ...ctx,
    resolveExtensionPath: ctx.resolveExtensionPath ?? (() => null),
    resolveExtensionArtifacts:
      ctx.resolveExtensionArtifacts ?? (() => ({})),
    auditEventTypes: AUDIT_EVENT_TYPES,
    auditSeverities: AUDIT_SEVERITIES,
    getAuditFeedSize,
    queryAuditFeed: (query) => queryAuditFeed(query as never) as never,
    subscribeAuditFeed,
  });
}
