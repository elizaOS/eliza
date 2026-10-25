/**
 * Parses the `eliza.ai/previous-agents` annotation the reconciler stamps on a
 * Server CR so the next reconcile can diff away agents that were removed from
 * the spec. Lives apart from reconciler.ts so the parsing contract is unit
 * testable without loading the pepr/kubernetes-fluent-client runtime graph
 * (pepr's CJS bundle `require()`s kubernetes-fluent-client, whose top-level
 * await makes that require fail under bun's per-file test isolation).
 */
import type { Server } from "./crd/generated/server-v1alpha1";

export function getPreviousAgentIds(instance: Server): string[] {
  const annotation =
    instance.metadata?.annotations?.["eliza.ai/previous-agents"];
  // Absent annotation legitimately means "no prior agents" (first reconcile).
  if (!annotation) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(annotation);
  } catch (err) {
    // A corrupt annotation must NOT read as "no previous agents": that would
    // silently skip removeAgentServer() for agents dropped since the last
    // reconcile, leaking stale Redis routing keys. Throw to the reconcile
    // loop's J1 boundary so the failure is logged and the annotation is not
    // overwritten with a lie.
    throw new Error(
      `Server ${instance.metadata?.name ?? "<unknown>"}: corrupt eliza.ai/previous-agents annotation`,
      { cause: err },
    );
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error(
      `Server ${instance.metadata?.name ?? "<unknown>"}: eliza.ai/previous-agents annotation is not a string array`,
    );
  }
  return parsed;
}
