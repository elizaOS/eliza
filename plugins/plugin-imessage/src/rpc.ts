import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { createInterface, type Interface } from "node:readline";

/**
 * Default probe timeout in milliseconds
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Default request timeout in milliseconds
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * iMessage RPC error structure
 */
export interface IMessageRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

/**
 * iMessage RPC response structure
 */
export interface IMessageRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: IMessageRpcError;
  method?: string;
  params?: unknown;
}

/**
 * iMessage RPC notification structure
 */
export interface IMessageRpcNotification {
  method: string;
  params?: unknown;
}

/**
 * Options for creating an iMessage RPC client
 */
export interface IMessageRpcClientOptions {
  cliPath?: string;
  dbPath?: string;
  onNotification?: (msg: IMessageRpcNotification) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Pending request tracking
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Resolves a path with ~ expansion
 */
function resolveUserPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolvePath(homedir(), path.slice(2));
  }
  return resolvePath(path);
}

/**
 * iMessage RPC client for communicating with the imsg CLI tool
 */
export class IMessageRpcClient {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly onNotification?: (msg: IMessageRpcNotification) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closedPromise: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private started = false;

  constructor(opts: IMessageRpcClientOptions = {}) {
    this.cliPath = opts.cliPath?.trim() || "imsg";
    this.dbPath = opts.dbPath?.trim() ? resolveUserPath(opts.dbPath) : undefined;
    this.onNotification = opts.onNotification;
    this.onError = opts.onError;
    this.onClose = opts.onClose;
    this.closedPromise = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  /**
   * Starts the RPC client by spawning the CLI process
   */
  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const args = ["rpc"];
    if (this.dbPath) {
      args.push("--db", this.dbPath);
    }

    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.started = true;
    this.reader = createInterface({ input: child.stdout });

    this.reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      this.handleLine(trimmed);
    });

    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        this.onError?.(new Error(`imsg rpc stderr: ${line.trim()}`));
      }
    });

    child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.closedResolve?.();
    });

    child.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        this.failAll(new Error(`imsg rpc exited (${reason})`));
      } else {
        this.failAll(new Error("imsg rpc closed"));
      }
      this.onClose?.(code, signal);
      this.closedResolve?.();
    });
  }

  /**
   * Stops the RPC client
   */
  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.reader?.close();
    this.reader = null;
    this.child.stdin?.end();

    const child = this.child;
    this.child = null;

    await Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          resolve();
        }, 500);
      }),
    ]);
  }

  /**
   * Waits for the RPC client to close
   */
  async waitForClose(): Promise<void> {
    await this.closedPromise;
  }

  /**
   * Checks if the client is running
   */
  isRunning(): boolean {
    return this.child !== null && this.started;
  }

  /**
   * Makes an RPC request
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    if (!this.child?.stdin) {
      throw new Error("imsg rpc not running");
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`imsg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;

      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.child.stdin.write(line);
    return await response;
  }

  /**
   * Handles an incoming line from the RPC process
   */
  private handleLine(line: string): void {
    let parsed: IMessageRpcResponse<unknown>;
    try {
      parsed = JSON.parse(line) as IMessageRpcResponse<unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.onError?.(new Error(`imsg rpc: failed to parse ${line}: ${detail}`));
      return;
    }

    // Handle response with ID
    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }

      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pending.delete(key);

      if (parsed.error) {
        const baseMessage = parsed.error.message ?? "imsg rpc error";
        const details = parsed.error.data;
        const code = parsed.error.code;
        const suffixes: string[] = [];

        if (typeof code === "number") {
          suffixes.push(`code=${code}`);
        }
        if (details !== undefined) {
          const detailText =
            typeof details === "string" ? details : JSON.stringify(details, null, 2);
          if (detailText) {
            suffixes.push(detailText);
          }
        }

        const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(" ")}` : baseMessage;
        pending.reject(new Error(msg));
        return;
      }

      pending.resolve(parsed.result);
      return;
    }

    // Handle notification
    if (parsed.method) {
      this.onNotification?.({
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  /**
   * Fails all pending requests
   */
  private failAll(err: Error): void {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}

/**
 * Creates and starts an iMessage RPC client
 */
export async function createIMessageRpcClient(
  opts: IMessageRpcClientOptions = {}
): Promise<IMessageRpcClient> {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}

/**
 * iMessage contact information
 */
export interface IMessageContact {
  id: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phones?: string[];
  emails?: string[];
}

/**
 * iMessage chat information
 */
export interface IMessageChat {
  id: string;
  chatIdentifier: string;
  guid?: string;
  displayName?: string;
  isGroup: boolean;
  participants: string[];
  service?: string;
  lastMessageDate?: number;
}

/**
 * iMessage message information
 */
export interface IMessageMessage {
  id: string;
  chatId: string;
  guid?: string;
  text?: string;
  sender: string;
  isFromMe: boolean;
  date: number;
  dateRead?: number;
  dateDelivered?: number;
  attachments?: IMessageAttachment[];
}

/**
 * iMessage attachment information
 */
export interface IMessageAttachment {
  id: string;
  filename?: string;
  mimeType?: string;
  path?: string;
  size?: number;
}

/**
 * Probes the iMessage RPC to check connectivity
 */
export async function probeIMessageRpc(params: {
  cliPath?: string;
  dbPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string; version?: string }> {
  const client = new IMessageRpcClient({
    cliPath: params.cliPath,
    dbPath: params.dbPath,
  });

  try {
    await client.start();
    await client.request<{ chats?: unknown[] }>(
      "chats.list",
      { limit: 1 },
      {
        timeoutMs: params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      }
    );
    await client.stop();
    return { ok: true };
  } catch (err) {
    await client.stop().catch(() => {});
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lists all contacts via iMessage RPC
 */
export async function listContacts(_client: IMessageRpcClient): Promise<IMessageContact[]> {
  throw new Error("imsg RPC does not expose contacts");
}

/**
 * Lists all chats via iMessage RPC
 */
export async function listChats(
  client: IMessageRpcClient,
  params: { limit?: number } = {}
): Promise<IMessageChat[]> {
  const response = await client.request<{
    chats?: Array<Record<string, unknown>>;
  }>("chats.list", {
    limit: params.limit ?? 20,
  });

  const chats = Array.isArray(response?.chats) ? response.chats : [];
  return chats.map((chat) => {
    const participants = Array.isArray(chat.participants)
      ? chat.participants.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
        )
      : [];
    const lastMessageAt =
      typeof chat.last_message_at === "string" ? Date.parse(chat.last_message_at) : Number.NaN;

    return {
      id: typeof chat.id === "string" || typeof chat.id === "number" ? String(chat.id) : "",
      chatIdentifier: typeof chat.identifier === "string" ? chat.identifier : "",
      guid: typeof chat.guid === "string" ? chat.guid : undefined,
      displayName:
        typeof chat.name === "string" && chat.name.trim().length > 0 ? chat.name.trim() : undefined,
      isGroup: Boolean(chat.is_group),
      participants,
      service: typeof chat.service === "string" ? chat.service : undefined,
      lastMessageDate: Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
    };
  });
}

/**
 * Gets recent messages from a chat
 */
export async function getMessages(
  client: IMessageRpcClient,
  params: {
    chatId: string | number;
    limit?: number;
    before?: number;
    attachments?: boolean;
    participants?: string[];
    start?: string;
    end?: string;
  }
): Promise<IMessageMessage[]> {
  const chatId =
    typeof params.chatId === "number" ? params.chatId : Number.parseInt(String(params.chatId), 10);
  if (!Number.isFinite(chatId)) {
    throw new Error("chatId must be numeric for imsg history requests");
  }

  const response = await client.request<{
    messages?: Array<Record<string, unknown>>;
  }>("messages.history", {
    chat_id: chatId,
    limit: params.limit,
    attachments: params.attachments,
    participants: params.participants,
    start: params.start,
    end: params.end,
  });

  const messages = Array.isArray(response?.messages) ? response.messages : [];
  return messages.map((message) => {
    const createdAt =
      typeof message.created_at === "string" ? Date.parse(message.created_at) : Number.NaN;
    const deliveredAt =
      typeof message.date_delivered === "string" ? Date.parse(message.date_delivered) : Number.NaN;
    const readAt =
      typeof message.date_read === "string" ? Date.parse(message.date_read) : Number.NaN;
    const attachments: IMessageAttachment[] = Array.isArray(message.attachments)
      ? message.attachments.reduce<IMessageAttachment[]>((acc, attachment) => {
          if (!attachment || typeof attachment !== "object") {
            return acc;
          }

          const raw = attachment as Record<string, unknown>;
          acc.push({
            id:
              typeof raw.filename === "string" && raw.filename.trim().length > 0
                ? raw.filename.trim()
                : typeof raw.original_path === "string"
                  ? raw.original_path
                  : "",
            filename: typeof raw.filename === "string" ? raw.filename : undefined,
            mimeType: typeof raw.mime_type === "string" ? raw.mime_type : undefined,
            path: typeof raw.original_path === "string" ? raw.original_path : undefined,
            size:
              typeof raw.total_bytes === "number"
                ? raw.total_bytes
                : typeof raw.total_bytes === "string"
                  ? Number.parseInt(raw.total_bytes, 10)
                  : undefined,
          });
          return acc;
        }, [])
      : [];

    return {
      id:
        typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : "",
      chatId:
        typeof message.chat_id === "string" || typeof message.chat_id === "number"
          ? String(message.chat_id)
          : "",
      guid: typeof message.guid === "string" ? message.guid : undefined,
      text: typeof message.text === "string" ? message.text : "",
      sender: typeof message.sender === "string" ? message.sender : "",
      isFromMe: Boolean(message.is_from_me),
      date: Number.isFinite(createdAt) ? createdAt : 0,
      dateRead: Number.isFinite(readAt) ? readAt : undefined,
      dateDelivered: Number.isFinite(deliveredAt) ? deliveredAt : undefined,
      attachments,
    };
  });
}

/**
 * Sends a message via iMessage RPC
 */
export async function sendIMessageRpc(
  client: IMessageRpcClient,
  params: {
    to: string;
    text: string;
    chatId?: string | number;
    chatIdentifier?: string;
    chatGuid?: string;
    attachments?: string[];
    service?: "iMessage" | "SMS";
  }
): Promise<{ ok: boolean }> {
  const file =
    Array.isArray(params.attachments) && params.attachments.length > 0
      ? params.attachments[0]
      : undefined;
  const service =
    params.service === "iMessage" ? "imessage" : params.service === "SMS" ? "sms" : "auto";
  const result = await client.request<{ ok?: boolean }>("send", {
    to: params.to,
    text: params.text,
    file,
    service,
    chat_id: params.chatId,
    chat_identifier: params.chatIdentifier,
    chat_guid: params.chatGuid,
  });
  return { ok: result?.ok !== false };
}

/**
 * Gets chat info via iMessage RPC
 */
export async function getChatInfo(
  client: IMessageRpcClient,
  params: { chatId: string }
): Promise<IMessageChat | null> {
  const chats = await listChats(client, { limit: 100 });
  return (
    chats.find(
      (chat) =>
        chat.id === params.chatId ||
        chat.chatIdentifier === params.chatId ||
        chat.guid === params.chatId
    ) ?? null
  );
}

/**
 * Gets contact info via iMessage RPC
 */
export async function getContactInfo(
  client: IMessageRpcClient,
  params: { identifier: string }
): Promise<IMessageContact | null> {
  void client;
  void params;
  throw new Error("imsg RPC does not expose contacts");
}
