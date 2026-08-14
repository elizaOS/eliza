/**
 * Join cloud domain — the post-login landing flow.
 *
 * `/join` is where Steward login resolves the account-native rowless Shared
 * Eliza, persists its Cloud binding, and enters chat. It never provisions
 * compute; paid Dedicated activation remains a separate explicit action.
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
