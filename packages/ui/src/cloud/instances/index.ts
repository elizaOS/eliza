/**
 * Instances cloud domain — hosted agent management ("Instances" + "My Agent").
 *
 * Mounts three authenticated routes under the cloud shell:
 *   - `dashboard/agents`            → the Instances table (list / create / status)
 *   - `dashboard/agents/:id`        → agent detail (overview / wallet / txns /
 *                                     policies / actions / backups / logs)
 *   - `dashboard/my-agents`         → character library + agent console
 *
 * Each page is code-split via `React.lazy` so its bundle (create-agent dialog,
 * wallet/transactions tabs, log viewers, recharts-free) only loads when the
 * route is opened. The routes register themselves against the shell's
 * cloud-route registry as an import side effect, mirroring the analytics /
 * api-keys domains. The Wave-3 settings section and the app shell can also
 * consume the exported page components directly.
 *
 * The cloud shell already mounts the `/dashboard/containers*` →
 * `/dashboard/agents*` compat redirects, so legacy deep links resolve here.
 *
 * ADDED in the migration (backend already supported, UI did not): Sleep / Wake
 * controls on the agent detail actions (deep cold suspend that frees the compute
 * slot via `POST /sleep`, and `POST /wake`).
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const AGENTS_ROUTE_PATH = "dashboard/agents";
export const AGENT_DETAIL_ROUTE_PATH = "dashboard/agents/:id";
export const MY_AGENTS_ROUTE_PATH = "dashboard/my-agents";

const AgentsPage = lazy(() => import("./AgentsPage"));
const AgentDetailPage = lazy(() => import("./AgentDetailPage"));
const MyAgentsPage = lazy(() => import("./MyAgentsPage"));

export type { AgentListItem } from "./lib/data/eliza-agents";
export { useAgent, useAgents } from "./lib/data/eliza-agents";
export { AgentDetailPage, AgentsPage, MyAgentsPage };

registerCloudRoute({
  path: AGENT_DETAIL_ROUTE_PATH,
  element: AgentDetailPage,
  group: "dashboard",
});

registerCloudRoute({
  path: AGENTS_ROUTE_PATH,
  element: AgentsPage,
  group: "dashboard",
});

registerCloudRoute({
  path: MY_AGENTS_ROUTE_PATH,
  element: MyAgentsPage,
  group: "dashboard",
});
