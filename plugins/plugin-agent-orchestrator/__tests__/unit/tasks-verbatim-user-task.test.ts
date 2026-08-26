/**
 * Pins TASKS create/spawn_agent child prompts against the demo-hello shape
 * (live 2026-08-21, task 5c6d85c0): the planner passed only the short label
 * "demo-hello page" as `task`, the child's "--- User Task ---" body carried
 * nothing else, and the verifier — grading the stored VERBATIM
 * originalRequest — failed "gradient and current date" three times before
 * parking. The child prompt must carry the user's verbatim ask INSIDE the
 * User Task section (label may prefix it) so builders and successors see the
 * asked features. Deterministic unit test with a stubbed runtime; no live
 * model.
 */
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { spawnAgentAction, tasksAction } from "../../src/actions/tasks.js";
import { userTaskFromInitialTask } from "../../src/services/user-task-text.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const VERBATIM =
  "build a tiny app called demo-hello: a page that says hello with a nice gradient and the current date, deploy it";
const LABEL = "demo-hello page";

describe("TASKS create carries the verbatim ask in the User Task body", () => {
  it("merges the short planner label with the complete verbatim request", async () => {
    const svc = serviceMock();
    const result = await tasksAction.handler(
      runtimeWith(svc),
      memory({ text: VERBATIM, source: "discord" }),
      state,
      {
        parameters: { action: "create", task: LABEL, workdir: os.tmpdir() },
      },
      callback(),
    );
    expect(result?.success).toBe(true);

    // The delivered prompt (direct path: sendPrompt) and the session-metadata
    // copy respawns rebuild from must BOTH carry the verbatim ask.
    const delivered = String(svc.sendPrompt.mock.calls[0]?.[1] ?? "");
    expect(delivered).toContain("--- User Task ---");
    const body = userTaskFromInitialTask(delivered);
    expect(body).toContain(LABEL);
    // PROMPT-INTEGRITY: the whole ask, verbatim — gradient and date included.
    expect(body).toContain(VERBATIM);

    const spawnCall = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: { initialTask?: string };
    };
    const storedBody = userTaskFromInitialTask(
      String(spawnCall.metadata?.initialTask ?? ""),
    );
    expect(storedBody).toContain(LABEL);
    expect(storedBody).toContain(VERBATIM);
  });

  it("does not duplicate the ask when the planner task already carries it", async () => {
    const svc = serviceMock();
    const result = await tasksAction.handler(
      runtimeWith(svc),
      memory({ text: VERBATIM, source: "discord" }),
      state,
      {
        parameters: { action: "create", task: VERBATIM, workdir: os.tmpdir() },
      },
      callback(),
    );
    expect(result?.success).toBe(true);
    const delivered = String(svc.sendPrompt.mock.calls[0]?.[1] ?? "");
    const body = userTaskFromInitialTask(delivered);
    const first = body.indexOf("gradient and the current date");
    expect(first).toBeGreaterThan(-1);
    expect(body.indexOf("gradient and the current date", first + 1)).toBe(-1);
  });
});

describe("TASKS spawn_agent carries the verbatim ask in the User Task body", () => {
  it("merges the short planner label with the complete verbatim request", async () => {
    const svc = serviceMock();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ text: VERBATIM, task: LABEL, workdir: process.cwd() }),
      state,
      { parameters: { action: "spawn_agent" } },
      callback(),
    );
    expect(result?.success).toBe(true);
    const spawnCall = svc.spawnSession.mock.calls[0]?.[0] as {
      initialTask?: string;
    };
    const body = userTaskFromInitialTask(String(spawnCall.initialTask ?? ""));
    expect(body).toContain(LABEL);
    expect(body).toContain(VERBATIM);
  });
});
