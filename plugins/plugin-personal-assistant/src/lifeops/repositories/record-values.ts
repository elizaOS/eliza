/** Normalizes persistence timestamps and owner-scope fields shared by LifeOps records. */
import { toText } from "../sql.js";

export function isoNow(): string {
  return new Date().toISOString();
}

export function parseOwnershipFields(row: Record<string, unknown>) {
  const subjectType =
    toText(row.subject_type, "owner") === "agent" ? "agent" : "owner";
  return {
    domain:
      toText(
        row.domain,
        subjectType === "agent" ? "agent_ops" : "user_lifeops",
      ) === "agent_ops"
        ? "agent_ops"
        : "user_lifeops",
    subjectType,
    subjectId: toText(row.subject_id, toText(row.agent_id)),
    visibilityScope:
      subjectType === "owner"
        ? "owner_only"
        : toText(row.visibility_scope, "agent_and_admin") === "owner_only"
          ? "owner_only"
          : toText(row.visibility_scope, "agent_and_admin") ===
              "agent_and_admin"
            ? "agent_and_admin"
            : "owner_agent_admin",
    contextPolicy:
      toText(
        row.context_policy,
        subjectType === "agent" ? "never" : "explicit_only",
      ) === "never"
        ? "never"
        : toText(
              row.context_policy,
              subjectType === "agent" ? "never" : "explicit_only",
            ) === "sidebar_only"
          ? "sidebar_only"
          : toText(
                row.context_policy,
                subjectType === "agent" ? "never" : "explicit_only",
              ) === "allowed_in_private_chat"
            ? "allowed_in_private_chat"
            : "explicit_only",
  } as const;
}
