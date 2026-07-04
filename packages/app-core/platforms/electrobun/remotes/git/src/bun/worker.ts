/** Implements Electrobun git remote worker ts boundaries for desktop app-core. */
import { serializeGitError } from "./errors.ts";
import { GitRemoteService } from "./git-service.ts";
import type {
  GitAddParams,
  GitBranchCreateParams,
  GitBranchDeleteParams,
  GitCheckoutParams,
  GitCommandRunParams,
  GitCommitParams,
  GitDiffParams,
  GitLogParams,
  GitMethod,
  GitRemoteOperationParams,
  GitRepoParams,
  GitResponsePayload,
  GitRestoreParams,
  GitWorkerOutboundMessage,
  GitWorkerRequestMessage,
  JsonValue,
} from "./protocol.ts";

const service = new GitRemoteService();

function post(message: GitWorkerOutboundMessage): void {
  self.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGitMethod(value: string): value is GitMethod {
  return (
    value === "git.status" ||
    value === "git.repo.info" ||
    value === "git.branches" ||
    value === "git.remotes" ||
    value === "git.log" ||
    value === "git.diff" ||
    value === "git.show" ||
    value === "git.add" ||
    value === "git.restore" ||
    value === "git.checkout" ||
    value === "git.branch.create" ||
    value === "git.branch.delete" ||
    value === "git.commit" ||
    value === "git.fetch" ||
    value === "git.pull" ||
    value === "git.push" ||
    value === "git.operation.list" ||
    value === "git.operation.get" ||
    value === "git.command.run"
  );
}

function parseRequest(value: unknown): GitWorkerRequestMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== "request") return null;
  const requestId = value.requestId;
  const method = value.method;
  if (
    (typeof requestId !== "string" && typeof requestId !== "number") ||
    typeof method !== "string" ||
    !isGitMethod(method)
  ) {
    throw new Error("Invalid Git Remote request.");
  }
  const params = value.params;
  return params === undefined
    ? { type: "request", requestId, method }
    : { type: "request", requestId, method, params: params as JsonValue };
}

async function dispatch(
  request: GitWorkerRequestMessage,
): Promise<GitResponsePayload> {
  switch (request.method) {
    case "git.status":
      return service.statusRepo(parseRepoParams(request.params));
    case "git.repo.info":
      return service.repoInfo(parseRepoParams(request.params));
    case "git.branches":
      return service.branches(parseRepoParams(request.params));
    case "git.remotes":
      return service.remotes(parseRepoParams(request.params));
    case "git.log":
      return service.log(parseLogParams(request.params));
    case "git.diff":
      return service.diff(parseDiffParams(request.params));
    case "git.show":
      return service.show(parseShowParams(request.params));
    case "git.add":
      return service.add(parseAddParams(request.params));
    case "git.restore":
      return service.restore(parseRestoreParams(request.params));
    case "git.checkout":
      return service.checkout(parseCheckoutParams(request.params));
    case "git.branch.create":
      return service.branchCreate(parseBranchCreateParams(request.params));
    case "git.branch.delete":
      return service.branchDelete(parseBranchDeleteParams(request.params));
    case "git.commit":
      return service.commit(parseCommitParams(request.params));
    case "git.fetch":
      return service.fetch(parseRemoteOperationParams(request.params));
    case "git.pull":
      return service.pull(parseRemoteOperationParams(request.params));
    case "git.push":
      return service.push(parseRemoteOperationParams(request.params));
    case "git.operation.list":
      return service.operationList(parseOperationListParams(request.params));
    case "git.operation.get":
      return service.operationGet({
        operationId: stringParam(request.params, "operationId"),
      });
    case "git.command.run":
      return service.commandRun(parseCommandRunParams(request.params));
  }
  const exhaustive: never = request.method;
  throw new Error(`Unsupported Git Remote method: ${exhaustive}`);
}

self.addEventListener("message", (event) => {
  void (async () => {
    let request: GitWorkerRequestMessage | null = null;
    try {
      request = parseRequest(event.data);
      if (request === null) return;
      const payload = await dispatch(request);
      post({
        type: "response",
        requestId: request.requestId,
        success: true,
        payload,
      });
    } catch (error) {
      if (request === null) return;
      post({
        type: "response",
        requestId: request.requestId,
        success: false,
        error: serializeGitError(error),
      });
    }
  })();
});

post({ type: "ready" });

function parseRepoParams(params?: JsonValue): GitRepoParams {
  if (params === undefined) return {};
  if (!isRecord(params)) throw new Error("Git repo params must be an object.");
  return {
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
  };
}

function parseDiffParams(params?: JsonValue): GitDiffParams {
  if (params === undefined) return {};
  if (!isRecord(params)) throw new Error("git.diff params must be an object.");
  return {
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.staged === "boolean" ? { staged: params.staged } : {}),
    ...(typeof params.path === "string" ? { path: params.path } : {}),
    ...(typeof params.ref === "string" ? { ref: params.ref } : {}),
  };
}

function parseLogParams(params?: JsonValue): GitLogParams {
  if (params === undefined) return {};
  if (!isRecord(params)) throw new Error("git.log params must be an object.");
  return {
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.ref === "string" ? { ref: params.ref } : {}),
  };
}

function parseShowParams(params?: JsonValue): {
  cwd?: string;
  ref: string;
  path?: string;
} {
  if (!isRecord(params)) throw new Error("git.show params must be an object.");
  return {
    ref: stringParam(params, "ref"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.path === "string" ? { path: params.path } : {}),
  };
}

function parseAddParams(params?: JsonValue): GitAddParams {
  if (!isRecord(params)) throw new Error("git.add params must be an object.");
  return {
    paths: stringArrayParam(params, "paths"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
  };
}

function parseRestoreParams(params?: JsonValue): GitRestoreParams {
  if (!isRecord(params))
    throw new Error("git.restore params must be an object.");
  return {
    paths: stringArrayParam(params, "paths"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.staged === "boolean" ? { staged: params.staged } : {}),
    ...(typeof params.source === "string" ? { source: params.source } : {}),
  };
}

function parseCheckoutParams(params?: JsonValue): GitCheckoutParams {
  if (!isRecord(params))
    throw new Error("git.checkout params must be an object.");
  return {
    ref: stringParam(params, "ref"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.createBranch === "boolean"
      ? { createBranch: params.createBranch }
      : {}),
  };
}

function parseBranchCreateParams(params?: JsonValue): GitBranchCreateParams {
  if (!isRecord(params))
    throw new Error("git.branch.create params must be an object.");
  return {
    name: stringParam(params, "name"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.checkout === "boolean"
      ? { checkout: params.checkout }
      : {}),
    ...(typeof params.startPoint === "string"
      ? { startPoint: params.startPoint }
      : {}),
  };
}

function parseBranchDeleteParams(params?: JsonValue): GitBranchDeleteParams {
  if (!isRecord(params))
    throw new Error("git.branch.delete params must be an object.");
  return {
    name: stringParam(params, "name"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.force === "boolean" ? { force: params.force } : {}),
  };
}

function parseCommitParams(params?: JsonValue): GitCommitParams {
  if (!isRecord(params))
    throw new Error("git.commit params must be an object.");
  return {
    message: stringParam(params, "message"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.amend === "boolean" ? { amend: params.amend } : {}),
    ...(typeof params.noVerify === "boolean"
      ? { noVerify: params.noVerify }
      : {}),
  };
}

function parseRemoteOperationParams(
  params?: JsonValue,
): GitRemoteOperationParams {
  if (params === undefined) return {};
  if (!isRecord(params))
    throw new Error("Git remote operation params must be an object.");
  return {
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(typeof params.remote === "string" ? { remote: params.remote } : {}),
    ...(typeof params.branch === "string" ? { branch: params.branch } : {}),
    ...(typeof params.setUpstream === "boolean"
      ? { setUpstream: params.setUpstream }
      : {}),
    ...(isStringArray(params.extraArgs) ? { extraArgs: params.extraArgs } : {}),
  };
}

function parseOperationListParams(params?: JsonValue): { limit?: number } {
  if (params === undefined) return {};
  if (!isRecord(params))
    throw new Error("git.operation.list params must be an object.");
  return {
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

function parseCommandRunParams(params?: JsonValue): GitCommandRunParams {
  if (!isRecord(params))
    throw new Error("git.command.run params must be an object.");
  return {
    args: stringArrayParam(params, "args"),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
  };
}

function stringParam(params: JsonValue | undefined, key: string): string {
  if (!isRecord(params) || typeof params[key] !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return params[key];
}

function stringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] {
  const value = params[key];
  if (!isStringArray(value)) throw new Error(`${key} must be a string array.`);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
