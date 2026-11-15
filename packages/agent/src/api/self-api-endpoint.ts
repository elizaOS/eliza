/**
 * Whether this process owns a TCP listener for its own API.
 *
 * Self calls attach the agent bearer. Without a listener of our own, any local
 * app can bind the loopback port and receive that bearer, so callers must not
 * fetch at all. The API server publishes the real listener state once it
 * either binds or skips the bind; before that the transport env decides.
 */
import { resolveSelfApiBaseUrl } from "@elizaos/host/protocol";

let publishedListenerState: boolean | undefined;

export const SELF_API_UNREACHABLE_TEXT =
  "The local API is not reachable in this build.";

/** Set by the API server; undefined returns to the env inference. */
export function setSelfApiTcpListenerBound(bound: boolean | undefined): void {
  publishedListenerState = bound;
}

export function hasSelfApiTcpListener(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (publishedListenerState !== undefined) return publishedListenerState;
  // Local-agent IPC binds no port unless ELIZA_API_EXPOSE_PORT re-opened it,
  // and the Android host only exports ELIZA_API_PORT in that case.
  return !(
    env.ELIZA_LOCAL_AGENT_TRANSPORT === "filesystem-v1" &&
    !env.ELIZA_API_PORT?.trim()
  );
}

/** Base URL for HTTP self calls, or null when nothing of ours listens. */
export function resolveSelfApiTcpBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return hasSelfApiTcpListener(env) ? resolveSelfApiBaseUrl(env) : null;
}
