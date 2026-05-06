/**
 * Wave 1.B default tool registry, with Wave 1.C's `spawn_codex` mixed in.
 *
 * `buildDefaultRegistry()` returns the safe-by-default inline tool surface
 * (file ops, web, memory, ignore). `addSpawnCodex()` adds the orchestrator-backed
 * subagent tool — split out so callers that don't have plugin-agent-
 * orchestrator wired (tests, lightweight runtimes) can opt out.
 */

import { registerTool, type ToolRegistry } from "../tool-schema.js";
import {
  createTaskHandler,
  createTaskTool,
  sessionsSpawnHandler,
  sessionsSpawnTool,
  spawnAgentHandler,
  spawnAgentTool,
} from "./acp_agent.js";
import {
  editFileHandler,
  editFileTool,
  globHandler,
  globTool,
  grepHandler,
  grepTool,
  readFileHandler,
  readFileTool,
  writeFileHandler,
  writeFileTool,
} from "./file_ops.js";
import * as ignore from "./ignore.js";
import {
  closeThreadHandler,
  closeThreadTool,
  journalHandler,
  journalTool,
  noteThreadHandler,
  noteThreadTool,
  updateProjectHandler,
  updateProjectTool,
} from "./journal_tools.js";
import {
  recallHandler,
  recallTool,
  rememberHandler,
  rememberTool,
} from "./memory.js";
import * as spawnCodex from "./spawn_codex.js";
import {
  webFetchHandler,
  webFetchTool,
  webSearchHandler,
  webSearchTool,
} from "./web.js";

export function buildDefaultRegistry(): ToolRegistry {
  const reg: ToolRegistry = new Map();
  registerTool(reg, readFileTool, readFileHandler);
  registerTool(reg, writeFileTool, writeFileHandler);
  registerTool(reg, editFileTool, editFileHandler);
  registerTool(reg, globTool, globHandler);
  registerTool(reg, grepTool, grepHandler);
  registerTool(reg, webFetchTool, webFetchHandler);
  registerTool(reg, webSearchTool, webSearchHandler);
  registerTool(reg, recallTool, recallHandler);
  registerTool(reg, rememberTool, rememberHandler);
  registerTool(reg, ignore.tool, ignore.handler);
  // journal_tools (nyx-specific autonomous state management)
  registerTool(reg, journalTool, journalHandler);
  registerTool(reg, noteThreadTool, noteThreadHandler);
  registerTool(reg, closeThreadTool, closeThreadHandler);
  registerTool(reg, updateProjectTool, updateProjectHandler);
  addSpawnCodex(reg);
  addAcpAgentTools(reg);
  return reg;
}

/** Add Wave 1.C's `spawn_codex` tool to an existing registry. Idempotent. */
export function addSpawnCodex(reg: ToolRegistry): ToolRegistry {
  registerTool(reg, spawnCodex.tool, spawnCodex.handler);
  return reg;
}

/** Add ACPX-backed native subagent tools to an existing registry. Idempotent. */
export function addAcpAgentTools(reg: ToolRegistry): ToolRegistry {
  registerTool(reg, spawnAgentTool, spawnAgentHandler);
  registerTool(reg, sessionsSpawnTool, sessionsSpawnHandler);
  registerTool(reg, createTaskTool, createTaskHandler);
  return reg;
}
