/**
 * Join cloud domain — the post-login landing flow.
 *
 * `/join` is where Steward login drops the user: it select-or-provisions a Cloud
 * agent (shared tier = instant), persists the `cloud:<agentId>` active server,
 * marks first-run complete, and hard-navigates to `/` so the app boots straight
 * into chat. This is the headline outcome of the cloud→Eliza migration: "the
 * main join experience takes you into your agent."
 *
 * The app shell imports {@link registerJoinFlow} once at boot to mount the route
 * against the cloud-route registry (mirroring public-pages / instances). The
 * login page's default `returnTo` points here.
 */

export { default as JoinPage } from "./JoinPage";
export {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./lib/resolve-cloud-connection";
export {
  dedicatedSubdomainBase,
  type JoinFlowClient,
  type JoinFlowEffects,
  type JoinFlowResult,
  type RunJoinFlowArgs,
  runJoinFlow,
} from "./lib/run-join-flow";
export {
  type JoinSessionAuthState,
  useJoinSessionAuth,
} from "./lib/use-join-session";
export { JOIN_ROUTE_PATH, registerJoinFlow } from "./register";
