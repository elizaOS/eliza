/**
 * Helpers for the "Connect Gmail →" missing-credentials banner that the
 * automations feed renders on workflow rows whose nodes reference
 * connectors the user hasn't connected yet.
 *
 * This file is logic-only (no JSX) so it can be unit-tested without a DOM.
 */

import type { WorkflowDefinition } from "../../api/client-types-chat";

/**
 * Walk a workflow's nodes and return the set of credential types it
 * references. The shape comes from `WorkflowDefinitionWriteNode.credentials`,
 * a `Record<credType, { id, name }>` populated by the workflow generator.
 */
export function collectWorkflowCredTypes(
  workflow: WorkflowDefinition | null | undefined,
): string[] {
  if (!workflow?.nodes) return [];
  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    const creds = (node as { credentials?: Record<string, unknown> })
      .credentials;
    if (!creds) continue;
    for (const credType of Object.keys(creds)) {
      seen.add(credType);
    }
  }
  return Array.from(seen);
}

/**
 * Subtract the set of providers the user has already connected from the
 * set of cred types referenced by the workflow. Returns the leftover —
 * the credentials that need a "Connect X →" CTA.
 *
 * `connectedProviders` is canonical provider ids (Gmail → "google", etc.);
 * the caller is responsible for translating cred types to providers via
 * `providerFromCredType` from `@elizaos/shared` before populating it.
 */
export function missingCredTypes(
  workflow: WorkflowDefinition | null | undefined,
  connectedCredTypes: ReadonlySet<string>,
): string[] {
  return collectWorkflowCredTypes(workflow).filter(
    (credType) => !connectedCredTypes.has(credType),
  );
}
