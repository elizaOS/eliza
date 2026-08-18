/**
 * ElizaClient extension (declaration-merged) for the native automations feed.
 * Requests go through
 * `workflowSurfaceClient` so a mobile device whose bundled runtime cannot host
 * plugin-workflow serves the surface from its linked Cloud agent instead.
 */
import { ElizaClient } from "./client-base";
import type { AutomationListResponse } from "./client-types-config";
import { workflowSurfaceClient } from "./workflow-surface-routing";

/** Automations list GET — existing 10s REST budget, independent hop. */
export const AUTOMATIONS_LIST_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    listAutomations(timeoutMs?: number): Promise<AutomationListResponse>;
  }
}

ElizaClient.prototype.listAutomations = async function (
  this: ElizaClient,
  timeoutMs: number = AUTOMATIONS_LIST_FETCH_TIMEOUT_MS,
): Promise<AutomationListResponse> {
  return workflowSurfaceClient(this).fetch<AutomationListResponse>(
    "/api/automations",
    undefined,
    { timeoutMs },
  );
};
