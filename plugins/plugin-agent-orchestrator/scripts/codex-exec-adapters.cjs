"use strict";

const adapters = require("coding-agent-adapters");

const CODEX_APPROVAL_FLAGS = {
  readonly: ["-s", "read-only"],
  standard: ["-s", "workspace-write"],
  permissive: ["-s", "workspace-write"],
  autonomous: ["--yolo"],
};
const CODEX_WEB_SEARCH_BY_PRESET = {
  readonly: false,
  standard: true,
  permissive: true,
  autonomous: true,
};
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const CODEX_TASK_AGENT_REASONING_EFFORT = "xhigh";

function settingIsOff(value) {
  if (typeof value !== "string") {
    return false;
  }
  return /^(?:off|false|0|none|disabled)$/i.test(value.trim());
}

function resolveCodexApprovalFlags(approvalPreset) {
  const sandboxMode =
    typeof process.env.CODEX_EXEC_SANDBOX_MODE === "string"
      ? process.env.CODEX_EXEC_SANDBOX_MODE.trim().toLowerCase()
      : "";

  if (sandboxMode) {
    if (settingIsOff(sandboxMode)) {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }

    if (CODEX_SANDBOX_MODES.has(sandboxMode)) {
      return ["-s", sandboxMode];
    }

    return ["-s", "read-only"];
  }

  if (settingIsOff(process.env.CODING_AGENT_SANDBOX)) {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  return (
    CODEX_APPROVAL_FLAGS[approvalPreset] ?? CODEX_APPROVAL_FLAGS.autonomous
  );
}

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
      "-c",
      `tools.web_search=${
        CODEX_WEB_SEARCH_BY_PRESET[approvalPreset] === false ? "false" : "true"
      }`,
    );

    const model =
      typeof config.env?.OPENAI_MODEL === "string"
        ? config.env.OPENAI_MODEL.trim()
        : "";
    if (model) {
      args.push("--model", model);
    }

    args.push(...resolveCodexApprovalFlags(approvalPreset));

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
