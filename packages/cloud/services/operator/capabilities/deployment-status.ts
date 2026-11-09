/** Tracks persisted deployment status so failed writes remain eligible for the next watch event. */
import type { Server, ServerPhase } from "./crd/generated/server-v1alpha1";

export class DeploymentStatusTracker {
  private readonly persisted = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly retired = new Set<string>();

  constructor(
    private readonly writeRouting: (
      name: string,
      phase: string,
      url: string,
    ) => Promise<void>,
    private readonly writeStatus: (
      name: string,
      namespace: string,
      status: Server["status"],
    ) => Promise<void>,
  ) {}

  forget(name: string, namespace: string): void {
    this.persisted.delete(`${namespace}/${name}`);
  }

  activate(name: string, namespace: string): void {
    this.retired.delete(`${namespace}/${name}`);
    this.forget(name, namespace);
  }

  finalize(
    name: string,
    namespace: string,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    // Fence queued and late watch events immediately; in-flight writes finish
    // before cleanup. A later Server reconciliation explicitly reactivates it.
    this.retired.add(`${namespace}/${name}`);
    return this.coordinate(name, namespace, async () => {
      // An earlier queued reconciliation may activate the Server after the
      // immediate fence above. Reassert it when this finalizer owns the queue.
      this.retired.add(`${namespace}/${name}`);
      await cleanup();
      this.forget(name, namespace);
    });
  }

  /** Order watch writes and reconciliation resets for one Server, not the whole fleet. */
  coordinate(
    name: string,
    namespace: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = `${namespace}/${name}`;
    const previous = this.pending.get(key) ?? Promise.resolve();
    // A failed prior operation remains rejected to its own caller. Subsequent
    // watch events still get to retry the unacknowledged state.
    const current = previous.then(operation, operation);
    this.pending.set(key, current);
    const release = () => {
      if (this.pending.get(key) === current) this.pending.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  async update(
    name: string,
    namespace: string,
    replicas: number,
    ready: number,
  ): Promise<void> {
    return this.coordinate(name, namespace, async () => {
      if (this.retired.has(`${namespace}/${name}`)) return;
      const phase: ServerPhase =
        replicas === 0 ? "ScaledDown" : ready > 0 ? "Running" : "Pending";
      const key = `${namespace}/${name}`;
      const snapshot = `${phase}:${replicas}:${ready}`;
      if (this.persisted.get(key) === snapshot) return;
      await this.writeRouting(
        name,
        phase.toLowerCase(),
        `http://${name}.${namespace}.svc:3000`,
      );
      await this.writeStatus(name, namespace, {
        phase,
        replicas: ready,
        lastActivity: new Date().toISOString(),
      });
      // Both destinations must acknowledge before duplicate watch events can be skipped.
      this.persisted.set(key, snapshot);
    });
  }
}
