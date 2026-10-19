/**
 * A reused session (no sub-agent router origin) runs a follow-up turn within
 * the post-completion eviction grace. Both turns' results must reach the
 * swarm-complete callback: the first turn's completion dedupe slot must not
 * swallow the second turn's result. Real SwarmCoordinatorService bound to a
 * stand-in ACP event source.
 */
import { afterEach, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

let service: SwarmCoordinatorService | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
});

it("posts the result of a follow-up turn on the same session", async () => {
  const handlers: Array<(id: string, event: string, data: unknown) => void> =
    [];
  const session = {
    id: "s1",
    agentType: "codex",
    workdir: "/tmp/swarm-followup",
    status: "ready",
    metadata: { label: "build" },
  };
  const acp = {
    onSessionEvent(
      handler: (id: string, event: string, data: unknown) => void,
    ) {
      handlers.push(handler);
      return () => {};
    },
    getSession: async (id: string) => (id === session.id ? session : undefined),
    updateSessionMetadata: async () => {},
  };
  const runtime = {
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : null,
    reportError: () => {},
  };
  service = new SwarmCoordinatorService(runtime as never);
  (service as unknown as { bindToAcp(): void }).bindToAcp();
  const posted: string[] = [];
  service.setSwarmCompleteCallback(async (payload) => {
    for (const task of payload.tasks) {
      posted.push(`${task.status}: ${task.completionSummary}`);
    }
  });
  const emit = (event: string, data: unknown) => {
    for (const handler of [...handlers]) handler(session.id, event, data);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  emit("task_complete", { response: "turn 1 answer" });
  await settle();
  // A follow-up turn on the same live session, inside the eviction grace.
  emit("message", { text: "working on the follow-up" });
  emit("tool_running", {});
  await settle();
  emit("task_complete", { response: "turn 2 answer" });
  await settle();

  expect(posted).toEqual([
    "completed: turn 1 answer",
    "completed: turn 2 answer",
  ]);
});
