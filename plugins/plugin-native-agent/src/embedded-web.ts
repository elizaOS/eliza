import { WebPlugin } from "@capacitor/core";
import {
  EMBEDDED_AGENT_PREFIX,
  type EmbeddedAgentPlugin,
  type EmbeddedAgentRequest,
  type EmbeddedAgentResponse,
  type EmbeddedAgentStatus,
} from "./embedded.js";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${EMBEDDED_AGENT_PREFIX}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error ?? value.code), {
      code: value.code,
    });
  return value as T;
}

/** The page's bridge in a browser: the development agent behind the Vite plugin. */
export class EmbeddedAgentWeb
  extends WebPlugin
  implements Omit<EmbeddedAgentPlugin, "addListener">
{
  private readonly streams = new Map<string, AbortController>();

  constructor() {
    super();
    new EventSource(`${EMBEDDED_AGENT_PREFIX}/status/events`).onmessage = (
      event,
    ) => this.notifyListeners("status", JSON.parse(event.data));
  }

  getStatus() {
    return call<EmbeddedAgentStatus>("/status");
  }
  start() {
    return call<EmbeddedAgentStatus>("/start", {});
  }
  restart() {
    return call<EmbeddedAgentStatus>("/restart", {});
  }
  stop() {
    return call<EmbeddedAgentStatus>("/stop", {});
  }
  request(options: EmbeddedAgentRequest) {
    return call<EmbeddedAgentResponse>("/request", options);
  }

  async requestStream({
    id,
    ...options
  }: EmbeddedAgentRequest & { id: string }) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || this.streams.has(id))
      throw Object.assign(new Error("A new stream id is required"), {
        code: "INVALID_STREAM_ID",
      });
    const controller = new AbortController();
    this.streams.set(id, controller);
    const response = await fetch(`${EMBEDDED_AGENT_PREFIX}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
      signal: controller.signal,
    }).catch((error: unknown) => {
      this.streams.delete(id);
      throw error;
    });
    if (response.status === 403) {
      this.streams.delete(id);
      const value = await response.json();
      throw Object.assign(new Error(value.error), { code: value.code });
    }
    void this.pump(id, response, controller.signal);
    return { id };
  }

  async abort({ id }: { id: string }) {
    const controller = this.streams.get(id);
    this.streams.delete(id);
    controller?.abort();
    return { aborted: controller !== undefined };
  }

  private async pump(id: string, response: Response, signal: AbortSignal) {
    try {
      if (
        !response.body ||
        !response.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        const value = await response.json();
        return this.notifyListeners(
          "streamEnd",
          response.ok
            ? { id, ...value }
            : { id, error: value.error, code: value.code },
        );
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffered = (buffered + (value ?? "")).replace(/\r\n?/g, "\n");
        let end = buffered.indexOf("\n\n");
        while (end >= 0 || (done && buffered.trim())) {
          const block = end >= 0 ? buffered.slice(0, end) : buffered;
          buffered = end >= 0 ? buffered.slice(end + 2) : "";
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
          if (data.length)
            this.notifyListeners("streamData", { id, data: data.join("\n") });
          end = buffered.indexOf("\n\n");
        }
        if (done) break;
      }
      this.notifyListeners("streamEnd", { id, status: response.status });
    } catch (error) {
      this.notifyListeners(
        "streamEnd",
        signal.aborted
          ? { id, aborted: true }
          : {
              id,
              error: error instanceof Error ? error.message : String(error),
            },
      );
    } finally {
      this.streams.delete(id);
    }
  }
}
