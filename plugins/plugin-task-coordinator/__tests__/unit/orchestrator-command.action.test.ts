/**
 * Exercises the task coordinator's slash-command action through the real
 * per-runtime registry, parser, handler, callback, and GUI wire projection.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  commandVisibleForSurface,
  findCommandByKey,
  initForRuntime,
  serializeCommand,
  useRuntime,
} from "@elizaos/plugin-commands";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATOR_STATUS_COMMAND_ACTION,
  ORCHESTRATOR_STATUS_COMMAND_KEY,
  ORCHESTRATOR_VIEW_ID,
  orchestratorStatusCommandAction,
  registerOrchestratorCommands,
} from "../../src/orchestrator-command";

const AGENT = "agent-orchestrator-command-test";

const runtime = { agentId: AGENT } as IAgentRuntime;
const message = (text: string): Memory =>
  ({ content: { text } }) as unknown as Memory;

describe("orchestrator slash command (#8790)", () => {
  beforeEach(() => {
    initForRuntime(AGENT);
    useRuntime(AGENT);
    registerOrchestratorCommands(AGENT);
  });

  it("registers a view-scoped, agent-target command", () => {
    const cmd = findCommandByKey(ORCHESTRATOR_STATUS_COMMAND_KEY);
    expect(cmd).toBeDefined();
    expect(cmd?.target).toEqual({
      kind: "agent",
      action: ORCHESTRATOR_STATUS_COMMAND_ACTION,
    });
    expect(cmd?.views).toEqual([ORCHESTRATOR_VIEW_ID]);
    expect(cmd?.surfaces).toEqual(["gui"]);
    expect(cmd?.acceptsArgs).toBe(false);
  });

  it("validate() matches the slash command only, never conversational text", async () => {
    const validate = orchestratorStatusCommandAction.validate;
    expect(validate).toBeDefined();
    if (!validate) return;
    expect(await validate(runtime, message("/orchestrator-status"))).toBe(true);
    expect(
      await validate(runtime, message("what is the orchestrator status?")),
    ).toBe(false);
    expect(await validate(runtime, message("/help"))).toBe(false);
    expect(await validate(runtime, message(""))).toBe(false);
  });

  it("handler returns a deterministic reply via callback, with no LLM call", async () => {
    const callback = vi.fn(async () => [] as Memory[]);
    const result = await orchestratorStatusCommandAction.handler(
      runtime,
      message("/orchestrator-status"),
      undefined,
      undefined,
      callback,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({
      text: "Orchestrator is online.",
      source: "command",
    });
    expect(result).toEqual({ success: true, text: "Orchestrator is online." });
  });

  it("serializes onto the wire shape and honors the GUI surface contract", () => {
    const cmd = findCommandByKey(ORCHESTRATOR_STATUS_COMMAND_KEY);
    expect(cmd).toBeDefined();
    if (!cmd) return;
    const wire = serializeCommand(cmd);
    expect(wire.target).toEqual({
      kind: "agent",
      action: ORCHESTRATOR_STATUS_COMMAND_ACTION,
    });
    expect(wire.views).toEqual([ORCHESTRATOR_VIEW_ID]);
    // Visible on the surfaces it declares, filtered out everywhere else.
    expect(commandVisibleForSurface(cmd.surfaces, "gui")).toBe(true);
    expect(commandVisibleForSurface(cmd.surfaces, "tui")).toBe(false);
    expect(commandVisibleForSurface(cmd.surfaces, "discord")).toBe(false);
    expect(commandVisibleForSurface(cmd.surfaces, "telegram")).toBe(false);
  });
});
