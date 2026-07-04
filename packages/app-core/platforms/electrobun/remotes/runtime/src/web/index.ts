/** Implements Electrobun runtime remote index ts boundaries for desktop app-core. */
import type {
  AgentMessageStreamEvent,
  RuntimeMethod,
  RuntimeWorkerOutboundMessage,
  RuntimeWorkerRequestMessage,
} from "../bun/protocol.ts";

const output = document.querySelector<HTMLPreElement>("#output");
const streamOutput = document.querySelector<HTMLPreElement>("#stream-output");
const streamSnapshot =
  document.querySelector<HTMLPreElement>("#stream-snapshot");
const activeStreamId = document.querySelector<HTMLElement>("#active-stream-id");
const buttons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-method]"),
);
const agentIdInput = document.querySelector<HTMLInputElement>("#agent-id");
const conversationIdInput =
  document.querySelector<HTMLInputElement>("#conversation-id");
const messageTextInput =
  document.querySelector<HTMLInputElement>("#message-text");
const memoryQueryInput =
  document.querySelector<HTMLInputElement>("#memory-query");
const logLimitInput = document.querySelector<HTMLInputElement>("#log-limit");
const worker = new Worker(new URL("../bun/worker.ts", import.meta.url), {
  type: "module",
});
let nextRequestId = 1;
let currentStreamId: string | null = null;

function append(value: string): void {
  if (output === null) return;
  output.textContent = `${output.textContent ?? ""}\n${value}`.trim();
  output.scrollTop = output.scrollHeight;
}

function appendStream(value: string): void {
  if (streamOutput === null) return;
  streamOutput.textContent = `${streamOutput.textContent ?? ""}${value}`;
  streamOutput.scrollTop = streamOutput.scrollHeight;
}

function setSnapshot(value: string): void {
  if (streamSnapshot === null) return;
  streamSnapshot.textContent = value;
}

function setActiveStreamId(value: string | null): void {
  currentStreamId = value;
  if (activeStreamId !== null) activeStreamId.textContent = value ?? "none";
}

function inputValue(input: HTMLInputElement | null): string {
  return input?.value.trim() ?? "";
}

function requestParams(
  method: RuntimeMethod,
): RuntimeWorkerRequestMessage["params"] {
  if (method === "runtime.logs.tail") {
    const limit = Number.parseInt(inputValue(logLimitInput), 10);
    return { limit: Number.isFinite(limit) ? limit : 80 };
  }
  if (method === "api.discover") return { refresh: true };
  if (method === "agent.get") return { agentId: inputValue(agentIdInput) };
  if (method === "agent.message" || method === "agent.message.stream") {
    const agentId = inputValue(agentIdInput);
    const conversationId = inputValue(conversationIdInput);
    return {
      text: inputValue(messageTextInput),
      ...(agentId.length > 0 ? { agentId } : {}),
      ...(conversationId.length > 0 ? { conversationId } : {}),
    };
  }
  if (
    method === "agent.message.stream.cancel" ||
    method === "agent.message.stream.status"
  ) {
    return { streamId: currentStreamId ?? "" };
  }
  if (method === "conversation.get") {
    return { conversationId: inputValue(conversationIdInput) };
  }
  if (method === "memory.search") {
    return { query: inputValue(memoryQueryInput), limit: 10 };
  }
  return undefined;
}

function send(method: RuntimeMethod): void {
  const request: RuntimeWorkerRequestMessage = {
    type: "request",
    requestId: nextRequestId++,
    method,
    ...(requestParams(method) === undefined
      ? {}
      : { params: requestParams(method) }),
  };
  append(`> ${method}`);
  worker.postMessage(request);
}

function handleStreamEvent(event: AgentMessageStreamEvent): void {
  if (event.kind === "started") {
    setActiveStreamId(event.streamId);
    if (streamOutput !== null) streamOutput.textContent = "";
    setSnapshot("Stream started.");
    return;
  }
  if (event.kind === "delta") {
    appendStream(event.delta ?? "");
    return;
  }
  if (event.kind === "snapshot") {
    setSnapshot(
      event.text ?? JSON.stringify(event.raw ?? event.payload, null, 2),
    );
    return;
  }
  if (event.kind === "action") {
    setSnapshot(
      JSON.stringify(
        {
          actionName: event.actionName,
          toolName: event.toolName,
          text: event.text,
          payload: event.payload,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (event.kind === "done") {
    setSnapshot(event.text ?? "Stream complete.");
    setActiveStreamId(null);
    return;
  }
  if (event.kind === "cancelled") {
    setSnapshot("Stream cancelled.");
    setActiveStreamId(null);
    return;
  }
  if (event.kind === "error") {
    setSnapshot(event.text ?? "Stream error.");
    setActiveStreamId(null);
  }
}

worker.addEventListener(
  "message",
  (event: MessageEvent<RuntimeWorkerOutboundMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      append("Runtime Remote worker ready.");
      return;
    }
    if (message.type === "event") {
      if (
        message.name.startsWith("agent.message.stream.") &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        "streamId" in message.payload &&
        "kind" in message.payload
      ) {
        handleStreamEvent(message.payload as AgentMessageStreamEvent);
      }
      append(
        `event ${message.name}: ${JSON.stringify(message.payload, null, 2)}`,
      );
      return;
    }
    if (
      message.type === "response" &&
      message.success &&
      typeof message.payload === "object" &&
      message.payload !== null &&
      "streamId" in message.payload &&
      typeof message.payload.streamId === "string"
    ) {
      setActiveStreamId(message.payload.streamId);
    }
    append(JSON.stringify(message, null, 2));
  },
);

for (const button of buttons) {
  button.addEventListener("click", () => {
    const method = button.dataset.method;
    if (typeof method === "string") send(method as RuntimeMethod);
  });
}
