/** Implements Electrobun PTY remote worker ts boundaries for desktop app-core. */
import { serializePtyError } from "./errors.ts";
import type {
  JsonValue,
  PtyCommandRunParams,
  PtyCreateSessionParams,
  PtyKillParams,
  PtyMethod,
  PtyOutputTailParams,
  PtyResizeParams,
  PtyResponsePayload,
  PtyWorkerOutboundMessage,
  PtyWorkerRequestMessage,
  PtyWriteParams,
} from "./protocol.ts";
import { TerminalRemoteService } from "./pty-service.ts";

const service = new TerminalRemoteService({
  emit: (event) => {
    post({
      type: "event",
      name: event.name,
      payload: event.payload,
    });
  },
});

function post(message: PtyWorkerOutboundMessage): void {
  self.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPtyMethod(value: string): value is PtyMethod {
  return (
    value === "pty.status" ||
    value === "pty.session.create" ||
    value === "pty.session.list" ||
    value === "pty.session.get" ||
    value === "pty.session.write" ||
    value === "pty.session.resize" ||
    value === "pty.session.kill" ||
    value === "pty.session.output.tail" ||
    value === "pty.session.output.clear" ||
    value === "pty.command.run"
  );
}

function parseRequest(value: unknown): PtyWorkerRequestMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== "request") return null;
  const requestId = value.requestId;
  const method = value.method;
  if (
    (typeof requestId !== "string" && typeof requestId !== "number") ||
    typeof method !== "string" ||
    !isPtyMethod(method)
  ) {
    throw new Error("Invalid Terminal Remote request.");
  }
  const params = value.params;
  return params === undefined
    ? { type: "request", requestId, method }
    : { type: "request", requestId, method, params: params as JsonValue };
}

async function dispatch(
  request: PtyWorkerRequestMessage,
): Promise<PtyResponsePayload> {
  switch (request.method) {
    case "pty.status":
      return service.status();
    case "pty.session.create":
      return service.createSession(parseCreateSessionParams(request.params));
    case "pty.session.list":
      return service.listSessions();
    case "pty.session.get":
      return service.getSession(stringParam(request.params, "sessionId"));
    case "pty.session.write":
      return service.write(parseWriteParams(request.params));
    case "pty.session.resize":
      return service.resize(parseResizeParams(request.params));
    case "pty.session.kill":
      return service.kill(parseKillParams(request.params));
    case "pty.session.output.tail":
      return service.outputTail(parseOutputTailParams(request.params));
    case "pty.session.output.clear":
      return service.outputClear({
        sessionId: stringParam(request.params, "sessionId"),
      });
    case "pty.command.run":
      return service.commandRun(parseCommandRunParams(request.params));
  }
  const exhaustive: never = request.method;
  throw new Error(`Unsupported Terminal Remote method: ${exhaustive}`);
}

self.addEventListener("message", (event) => {
  void (async () => {
    let request: PtyWorkerRequestMessage | null = null;
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
        error: serializePtyError(error),
      });
    }
  })();
});

post({ type: "ready" });

function parseCreateSessionParams(params?: JsonValue): PtyCreateSessionParams {
  if (params === undefined) return {};
  if (!isRecord(params))
    throw new Error("pty.session.create params must be an object.");
  return {
    ...(typeof params.command === "string" ? { command: params.command } : {}),
    ...(isStringArray(params.args) ? { args: params.args } : {}),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(isStringRecord(params.env) ? { env: params.env } : {}),
    ...(typeof params.cols === "number" ? { cols: params.cols } : {}),
    ...(typeof params.rows === "number" ? { rows: params.rows } : {}),
    ...(typeof params.name === "string" ? { name: params.name } : {}),
  };
}

function parseWriteParams(params?: JsonValue): PtyWriteParams {
  return {
    sessionId: stringParam(params, "sessionId"),
    data: stringParam(params, "data"),
  };
}

function parseResizeParams(params?: JsonValue): PtyResizeParams {
  if (!isRecord(params))
    throw new Error("pty.session.resize params must be an object.");
  return {
    sessionId: stringParam(params, "sessionId"),
    cols: numberParam(params, "cols"),
    rows: numberParam(params, "rows"),
  };
}

function parseKillParams(params?: JsonValue): PtyKillParams {
  if (!isRecord(params))
    throw new Error("pty.session.kill params must be an object.");
  return {
    sessionId: stringParam(params, "sessionId"),
    ...(typeof params.signal === "string" ? { signal: params.signal } : {}),
  };
}

function parseOutputTailParams(params?: JsonValue): PtyOutputTailParams {
  if (!isRecord(params))
    throw new Error("pty.session.output.tail params must be an object.");
  return {
    sessionId: stringParam(params, "sessionId"),
    ...(typeof params.afterSequence === "number"
      ? { afterSequence: params.afterSequence }
      : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

function parseCommandRunParams(params?: JsonValue): PtyCommandRunParams {
  if (!isRecord(params) || typeof params.command !== "string") {
    throw new Error("pty.command.run command must be a string.");
  }
  return {
    command: params.command,
    ...(isStringArray(params.args) ? { args: params.args } : {}),
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    ...(isStringRecord(params.env) ? { env: params.env } : {}),
    ...(typeof params.timeoutMs === "number"
      ? { timeoutMs: params.timeoutMs }
      : {}),
  };
}

function stringParam(params: JsonValue | undefined, key: string): string {
  if (!isRecord(params) || typeof params[key] !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return params[key];
}

function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
