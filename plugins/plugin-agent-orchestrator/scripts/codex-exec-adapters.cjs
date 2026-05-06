"use strict";

const adapters = require("coding-agent-adapters");

const CODEX_APPROVAL_FLAGS = {
  readonly: ["-s", "read-only"],
  standard: ["-s", "workspace-write"],
  permissive: ["-s", "workspace-write"],
  autonomous: ["--yolo"],
};

const CODEX_TASK_AGENT_REASONING_EFFORT = "xhigh";

function patchCodexAdapter(adapter) {
  if (!adapter || adapter.adapterType !== "codex") {
    return adapter;
  }

  const originalGetArgs = adapter.getArgs.bind(adapter);
  adapter.getArgs = (config = {}) => {
    const adapterConfig = config.adapterConfig ?? {};
    const initialPrompt =
      typeof adapterConfig.initialPrompt === "string"
        ? adapterConfig.initialPrompt.trim()
        : "";
    if (!initialPrompt) {
      return originalGetArgs(config);
    }

    const approvalPreset =
      typeof adapterConfig.approvalPreset === "string"
        ? adapterConfig.approvalPreset
        : "autonomous";
    const args = ["exec"];
    args.push("--ignore-rules", "--ephemeral");
    args.push(
      "-c",
      `model_reasoning_effort=${CODEX_TASK_AGENT_REASONING_EFFORT}`,
    );

    const model =
      typeof config.env?.OPENAI_MODEL === "string"
        ? config.env.OPENAI_MODEL.trim()
        : "";
    if (model) {
      args.push("--model", model);
    }

    args.push(
      ...(CODEX_APPROVAL_FLAGS[approvalPreset] ??
        CODEX_APPROVAL_FLAGS.autonomous),
    );

    if (config.workdir) {
      args.push("-C", config.workdir);
    }
    if (adapterConfig.skipGitRepoCheck === true) {
      args.push("--skip-git-repo-check");
    }

    args.push("--color", "never");

    const outputLastMessage =
      typeof adapterConfig.outputLastMessage === "string"
        ? adapterConfig.outputLastMessage.trim()
        : "";
    if (outputLastMessage) {
      args.push("--output-last-message", outputLastMessage);
    }

    args.push(initialPrompt);
    return args;
  };

  return adapter;
}

function createAllAdapters(...args) {
  return adapters.createAllAdapters(...args).map(patchCodexAdapter);
}

module.exports = {
  ...adapters,
  createAllAdapters,
};
