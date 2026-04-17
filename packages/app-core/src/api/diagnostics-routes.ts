import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLifeOpsBrowserCompanionPackageStatus } from "@elizaos/app-lifeops/routes/lifeops-browser-packaging";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "@elizaos/agent/security/audit-log";
import {
  type DiagnosticsRouteContext as AutonomousDiagnosticsRouteContext,
  handleDiagnosticsRoutes as handleAutonomousDiagnosticsRoutes,
} from "@elizaos/agent/api/diagnostics-routes";

type DiagnosticsRouteContext = Omit<
  AutonomousDiagnosticsRouteContext,
  | "auditEventTypes"
  | "auditSeverities"
  | "getAuditFeedSize"
  | "queryAuditFeed"
  | "subscribeAuditFeed"
>;

function defaultResolveExtensionPath(): string | null {
  return defaultResolveExtensionArtifacts().extensionPath ?? null;
}

function defaultResolveExtensionArtifacts() {
  try {
    const serverDir = path.dirname(fileURLToPath(import.meta.url));
    const extensionPath = path.resolve(
      serverDir,
      "..",
      "..",
      "apps",
      "extensions",
      "lifeops-browser",
    );
    if (!fs.existsSync(extensionPath)) {
      return getLifeOpsBrowserCompanionPackageStatus();
    }
    const status = getLifeOpsBrowserCompanionPackageStatus();
    return {
      ...status,
      extensionPath,
    };
  } catch {
    return getLifeOpsBrowserCompanionPackageStatus();
  }
}

export async function handleDiagnosticsRoutes(
  ctx: DiagnosticsRouteContext,
): Promise<boolean> {
  return handleAutonomousDiagnosticsRoutes({
    ...ctx,
    resolveExtensionPath:
      ctx.resolveExtensionPath ?? defaultResolveExtensionPath,
    resolveExtensionArtifacts:
      ctx.resolveExtensionArtifacts ?? defaultResolveExtensionArtifacts,
    auditEventTypes: AUDIT_EVENT_TYPES,
    auditSeverities: AUDIT_SEVERITIES,
    getAuditFeedSize,
    queryAuditFeed: (query) => queryAuditFeed(query as never) as never,
    subscribeAuditFeed,
  });
}
