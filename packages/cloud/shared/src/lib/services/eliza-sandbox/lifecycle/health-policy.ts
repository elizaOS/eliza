/** Classifies container health observations and defines liveness reconciliation outcomes. */

/** Outcome of a stale-tailnet-IP reconcile attempt (see reconcileStaleTailnetIp). */
export type TailnetIpReconcileResult =
  | { outcome: "repaired"; headscaleIp: string; bridgeUrl: string; healthUrl: string }
  | { outcome: "container-dead"; failureKind: ContainerRuntimeFailureKind }
  | { outcome: "ip-unresolvable" }
  | { outcome: "unrepairable" };

export type ContainerRuntimeFailureKind =
  | "healthy"
  | "inspect_unavailable"
  | "oom_killed"
  | "module_resolution"
  | "heap_oom"
  | "startup_failed"
  | "terminal_database"
  | "memory_watchdog_restart"
  | "port_conflict"
  | "mesh_auth"
  | "restarting"
  | "exited_nonzero"
  | "exited_zero"
  | "unhealthy"
  | "starting"
  | "not_running"
  | "unknown";

export type ContainerRuntimeHealthObservation = {
  healthy: boolean;
  failureKind: ContainerRuntimeFailureKind;
};

/** Reduces the closed Docker/log observation to one operator-safe liveness cause. */
export function classifyContainerRuntimeHealthObservation(
  output: string,
): ContainerRuntimeHealthObservation {
  const inspect = /^state=(\S+) health=(\S+) exit=(-?\d+) oom=(true|false) restarts=(\d+)$/m.exec(
    output,
  );
  if (!inspect) return { healthy: false, failureKind: "inspect_unavailable" };
  const state = inspect[1];
  const health = inspect[2];
  const exitCode = Number.parseInt(inspect[3]!, 10);
  const oomKilled = inspect[4] === "true";
  const signal = (name: string): boolean => new RegExp(`^${name}=true$`, "m").test(output);

  if (state === "running" && health === "healthy") {
    return { healthy: true, failureKind: "healthy" };
  }
  if (oomKilled) return { healthy: false, failureKind: "oom_killed" };
  if (signal("module_resolution")) {
    return { healthy: false, failureKind: "module_resolution" };
  }
  if (signal("heap_oom")) return { healthy: false, failureKind: "heap_oom" };
  if (signal("startup_failed")) {
    return { healthy: false, failureKind: "startup_failed" };
  }
  if (signal("terminal_database")) {
    return { healthy: false, failureKind: "terminal_database" };
  }
  if (signal("memory_watchdog")) {
    return { healthy: false, failureKind: "memory_watchdog_restart" };
  }
  if (signal("port_conflict")) {
    return { healthy: false, failureKind: "port_conflict" };
  }
  if (signal("mesh_auth")) return { healthy: false, failureKind: "mesh_auth" };
  if (state === "restarting") return { healthy: false, failureKind: "restarting" };
  if (state === "exited" || state === "dead") {
    return {
      healthy: false,
      failureKind: exitCode === 0 ? "exited_zero" : "exited_nonzero",
    };
  }
  if (state === "running" && health === "unhealthy") {
    return { healthy: false, failureKind: "unhealthy" };
  }
  if (state === "running" && health === "starting") {
    return { healthy: false, failureKind: "starting" };
  }
  if (state !== "running") return { healthy: false, failureKind: "not_running" };
  return { healthy: false, failureKind: "unknown" };
}
