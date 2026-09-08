/** Classifies provider stop failures for fail-closed sandbox deletion. */

export type SandboxDeleteStopFailureKind =
  | "teardown_locator_unresolved"
  | "teardown_node_metadata_missing"
  | "teardown_node_hostname_missing"
  | "ssh_authentication"
  | "ssh_transport"
  | "remote_command_timeout"
  | "docker_daemon"
  | "docker_stop_pair_failed"
  | "provider_initialization"
  | "unclassified";

/** Reduces a provider exception to a closed, secret-free teardown diagnosis. */
export function classifySandboxDeleteStopFailure(error: unknown): SandboxDeleteStopFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("not found in memory or db. cannot resolve target node")) {
    return "teardown_locator_unresolved";
  }
  if (normalized.includes("missing persisted docker node metadata")) {
    return "teardown_node_metadata_missing";
  }
  if (normalized.includes("docker node") && normalized.includes("is missing hostname")) {
    return "teardown_node_hostname_missing";
  }
  if (
    normalized.includes("authentication failed") ||
    normalized.includes("permission denied") ||
    normalized.includes("no supported authentication methods") ||
    normalized.includes("publickey")
  ) {
    return "ssh_authentication";
  }
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("enetunreach") ||
    normalized.includes("no route to host") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset") ||
    normalized.includes("connection timed out") ||
    normalized.includes("connect timeout") ||
    normalized.includes("getaddrinfo")
  ) {
    return "ssh_transport";
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "remote_command_timeout";
  }
  if (
    normalized.includes("cannot connect to the docker daemon") ||
    normalized.includes("docker daemon")
  ) {
    return "docker_daemon";
  }
  if (
    normalized.includes("failed to stop container") ||
    (normalized.includes("docker stop ->") && normalized.includes("docker rm -f ->"))
  ) {
    return "docker_stop_pair_failed";
  }
  if (!normalized.includes("docker-sandbox")) return "provider_initialization";
  return "unclassified";
}
