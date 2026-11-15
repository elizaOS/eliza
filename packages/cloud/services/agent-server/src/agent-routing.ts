/** Orders routing snapshots with retirement of the same manager-owned state. */
import { AgentMutationQueue } from "./agent-lifecycle";

export class AgentRoutingPublicationClosedError extends Error {
  readonly code = "AGENT_ROUTING_PUBLICATION_CLOSED";
}

export class AgentRoutingPublisher {
  private readonly queue = new AgentMutationQueue();
  private closed = false;

  publish(snapshotAndWrite: () => Promise<void>): Promise<void> {
    return this.queue.run("routing", async () => {
      if (this.closed)
        throw new AgentRoutingPublicationClosedError(
          "Agent routing publisher is closed",
        );
      // Snapshot inside the owned callback, never while waiting on an older write.
      await snapshotAndWrite();
    });
  }

  retire(
    removeOwnedRouting: () => Promise<void>,
    releaseLocalEntry: () => void,
  ): Promise<void> {
    return this.queue.run("routing", async () => {
      await removeOwnedRouting();
      releaseLocalEntry();
    });
  }

  close(removeServerState: () => Promise<void>): Promise<void> {
    this.closed = true;
    return this.queue.run("routing", removeServerState);
  }
}
