/** Tracks persisted deployment status so failed writes remain eligible for the next watch event. */
import type { Server, ServerPhase } from "./crd/generated/server-v1alpha1";

export class DeploymentStatusTracker {
  private readonly persisted = new Map<string, string>();

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

  async update(
    name: string,
    namespace: string,
    replicas: number,
    ready: number,
  ): Promise<void> {
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
  }
}
