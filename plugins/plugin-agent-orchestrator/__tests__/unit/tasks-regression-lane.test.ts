/**
 * Composes the task-action behavioral matrix for changes to the large
 * orchestrator task module. It covers creation, listing, history, lifecycle,
 * control, dispatch, workspace provisioning, aliases, and validation through
 * the production action handlers.
 */
import { expect, it } from "vitest";
import "./archive-reopen-lifecycle.test";
import "./cancel-task.test";
import "./control-resume-clears-paused.test";
import "./create-task-attaches-sessions.test";
import "./create-task-emits-widget-block.test";
import "./create-task.test";
import "./list-agents.test";
import "./provision-workspace.test";
import "./send-to-agent.test";
import "./spawn-agent.test";
import "./stop-agent.test";
import "./task-control-structural.test";
import "./task-history.test";
import "./tasks-action-aliases.test";
import "./tasks-create-validator-lifecycle.test";

it("loads the task-action regression matrix", () => {
  expect(true).toBe(true);
});
