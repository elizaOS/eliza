import { serializeFileError } from "./errors.ts";
import { FileRemoteService } from "./fs-service.ts";
import type {
  FileListParams,
  FileMethod,
  FileReadTextParams,
  FileSearchParams,
  FileWorkerOutboundMessage,
  FileWorkerRequestMessage,
  FileWriteTextParams,
  JsonValue,
} from "./protocol.ts";

const service = new FileRemoteService();

function post(message: FileWorkerOutboundMessage): void {
  self.postMessage(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileMethod(value: string): value is FileMethod {
  return (
    value === "fs.status" ||
    value === "fs.roots" ||
    value === "fs.stat" ||
    value === "fs.list" ||
    value === "fs.readText" ||
    value === "fs.search" ||
    value === "fs.writeText"
  );
}

function parseRequest(value: unknown): FileWorkerRequestMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== "request") return null;
  const requestId = value.requestId;
  const method = value.method;
  if (
    (typeof requestId !== "string" && typeof requestId !== "number") ||
    typeof method !== "string" ||
    !isFileMethod(method)
  ) {
    throw new Error("Invalid File Remote request.");
  }
  const params = value.params;
  return params === undefined
    ? { type: "request", requestId, method }
    : { type: "request", requestId, method, params: params as JsonValue };
}

async function dispatch(request: FileWorkerRequestMessage): Promise<unknown> {
  switch (request.method) {
    case "fs.status":
      return service.status();
    case "fs.roots":
      return service.roots();
    case "fs.stat":
      return service.stat(parsePathParams(request.params));
    case "fs.list":
      return service.list(parseListParams(request.params));
    case "fs.readText":
      return service.readText(parseReadTextParams(request.params));
    case "fs.search":
      return service.search(parseSearchParams(request.params));
    case "fs.writeText":
      return service.writeText(parseWriteTextParams(request.params));
  }
  const exhaustive: never = request.method;
  throw new Error(`Unsupported File Remote method: ${exhaustive}`);
}

self.addEventListener("message", (event) => {
  void (async () => {
    let request: FileWorkerRequestMessage | null = null;
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
        error: serializeFileError(error),
      });
    }
  })();
});

post({ type: "ready" });

function parsePathParams(params?: JsonValue): { path: string } {
  if (!isRecord(params) || typeof params.path !== "string") {
    throw new Error("path must be a string.");
  }
  return { path: params.path };
}

function parseListParams(params?: JsonValue): FileListParams {
  if (params === undefined) return {};
  if (!isRecord(params)) throw new Error("fs.list params must be an object.");
  return {
    ...(typeof params.path === "string" ? { path: params.path } : {}),
    ...(typeof params.rootId === "string" ? { rootId: params.rootId } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.includeHidden === "boolean"
      ? { includeHidden: params.includeHidden }
      : {}),
    ...(Array.isArray(params.ignore)
      ? {
          ignore: params.ignore.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}

function parseReadTextParams(params?: JsonValue): FileReadTextParams {
  if (!isRecord(params) || typeof params.path !== "string") {
    throw new Error("fs.readText path must be a string.");
  }
  return {
    path: params.path,
    ...(typeof params.maxBytes === "number"
      ? { maxBytes: params.maxBytes }
      : {}),
  };
}

function parseSearchParams(params?: JsonValue): FileSearchParams {
  if (!isRecord(params) || typeof params.query !== "string") {
    throw new Error("fs.search query must be a string.");
  }
  return {
    query: params.query,
    ...(typeof params.path === "string" ? { path: params.path } : {}),
    ...(typeof params.rootId === "string" ? { rootId: params.rootId } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    ...(typeof params.includeHidden === "boolean"
      ? { includeHidden: params.includeHidden }
      : {}),
  };
}

function parseWriteTextParams(params?: JsonValue): FileWriteTextParams {
  if (
    !isRecord(params) ||
    typeof params.path !== "string" ||
    typeof params.text !== "string"
  ) {
    throw new Error("fs.writeText path and text must be strings.");
  }
  return {
    path: params.path,
    text: params.text,
    ...(typeof params.createDirectories === "boolean"
      ? { createDirectories: params.createDirectories }
      : {}),
    ...(typeof params.overwrite === "boolean"
      ? { overwrite: params.overwrite }
      : {}),
  };
}
