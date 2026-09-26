/** Connects a user-owned native messaging socket to one exact Chromium profile without browser replay. */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { BrowserTarget } from "./browser-service.js";
import { BrowserDispatchFailure } from "./dispatch-types.js";
import {
  acknowledgeNativeChunk,
  NativeMessageAssembler,
  NativeMessageSender,
} from "./native-wire.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

const capabilities = new Set([
  "list",
  "open",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "scroll",
  "back",
  "forward",
  "reload",
  "close",
]);
interface NativeReply {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class NativeSocketBrowserTarget implements BrowserTarget {
  readonly id = "chromium-device";
  readonly name = "This device's Chromium";
  readonly description =
    "The registered native Chromium profile, including background tabs. Explicit tab IDs preserve the user's actual session.";
  readonly kind = "external" as const;
  readonly priority = 200;
  private socket: Socket | null = null;
  private server: Server | null = null;
  private sender: NativeMessageSender | null = null;
  private profileId: string | null = null;
  private advertised = new Set<string>();
  private pending = new Map<string, NativeReply>();
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private lastTransportDiagnostic: string | null = null;
  private ownedPath: string | null = null;
  constructor(
    private readonly onDiagnostic: (error: Error) => void,
    private readonly liveness = { registrationMs: 30000, heartbeatMs: 90000 },
  ) {}

  private reportConnectionError(error: Error): void {
    if (this.stopped) return;
    const code = "code" in error ? String(error.code) : "";
    const unavailable =
      ["ECONNREFUSED", "ENOENT", "ECONNRESET"].includes(code) ||
      (error instanceof BrowserDispatchFailure && error.kind === "UNAVAILABLE");
    const diagnostic = unavailable ? "unavailable" : `${code}:${error.message}`;
    if (this.lastTransportDiagnostic === diagnostic) return;
    this.lastTransportDiagnostic = diagnostic;
    this.onDiagnostic(
      unavailable
        ? new BrowserDispatchFailure(
            "UNAVAILABLE",
            "The native Chromium transport is not connected.",
            { targetId: this.id, cause: error },
          )
        : error,
    );
  }
  available = async (): Promise<boolean> => this.getProfileId() !== null;
  supports = (command: BrowserWorkspaceCommand): boolean =>
    capabilities.has(command.subaction) &&
    this.advertised.has(command.subaction) &&
    (!command.id || /^\d+$/.test(command.id));
  getProfileId(): string | null {
    return !this.stopped && this.socket && !this.socket.destroyed
      ? this.profileId
      : null;
  }

  async start(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const android = [env.ELIZA_PLATFORM, env.ELIZA_MOBILE_PLATFORM].includes(
      "android",
    );
    if (android) {
      this.connectAndroid();
      return;
    }
    const path =
      env.ELIZA_BROWSER_NATIVE_SOCKET ||
      (env.XDG_RUNTIME_DIR
        ? join(env.XDG_RUNTIME_DIR, "eliza", "browser-native.sock")
        : null);
    if (!path) return;
    if (!isAbsolute(path))
      throw new Error(
        "ELIZA_BROWSER_NATIVE_SOCKET must be an absolute local socket path.",
      );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const directory = await stat(dirname(path));
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
      throw new Error(
        "Native browser socket directory must be private to the runtime user.",
      );
    const server = createServer((socket) => this.attach(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.ownedPath = path;
    await chmod(path, 0o600);
    server.on("error", (error) => this.onDiagnostic(error));
  }

  private connectAndroid(): void {
    if (this.stopped) return;
    const socket = createConnection({
      path: "\0ai.elizaos.app.browser.native",
    });
    socket.once("connect", () => this.attach(socket));
    socket.on("error", (error) => this.reportConnectionError(error));
    socket.once("close", () => {
      if (!this.stopped)
        this.reconnect = setTimeout(() => this.connectAndroid(), 3000);
    });
  }

  private attach(socket: Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    let buffer = Buffer.alloc(0);
    let deadline: ReturnType<typeof setTimeout>;
    const armDeadline = (milliseconds: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        this.reportConnectionError(
          new BrowserDispatchFailure(
            "UNAVAILABLE",
            "Native browser liveness deadline expired.",
            { targetId: this.id },
          ),
        );
        socket.destroy();
      }, milliseconds);
      deadline.unref();
    };
    armDeadline(this.liveness.registrationMs);
    const post = (frame: unknown) => {
      if (socket.destroyed) throw new Error("Native browser connection ended.");
      const body = Buffer.from(JSON.stringify(frame));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    const sender = new NativeMessageSender(post);
    this.sender = sender;
    const assembler = new NativeMessageAssembler();
    socket.on("data", (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > 64 * 1024 || length === 0)
            throw new Error("Invalid native browser frame length.");
          if (buffer.length < length + 4) break;
          const frame = JSON.parse(
            buffer.subarray(4, length + 4).toString("utf8"),
          );
          buffer = buffer.subarray(length + 4);
          if (sender.acceptAcknowledgement(frame)) continue;
          const message = assembler.accept(frame);
          acknowledgeNativeChunk(frame, post);
          if (message) {
            this.receive(message, post);
            const validated = message as Record<string, unknown>;
            if (validated.type === "hello") {
              clearTimeout(deadline);
              // Legacy peers without nonce support remain compatible; new peers
              // must demonstrate end-to-end liveness through regular pings.
              if (typeof validated.nonce === "string")
                armDeadline(this.liveness.heartbeatMs);
            } else if (validated.type === "ping")
              armDeadline(this.liveness.heartbeatMs);
          }
        }
      } catch (error) {
        // error-policy:J3 malformed native transport is disconnected before any partial result is used.
        this.onDiagnostic(
          error instanceof Error ? error : new Error(String(error)),
        );
        socket.destroy();
      }
    });
    socket.on("error", (error) => this.reportConnectionError(error));
    socket.once("close", () => {
      clearTimeout(deadline);
      if (this.socket !== socket) return;
      sender.close(new Error("Native browser transport disconnected."));
      this.sender = null;
      this.socket = null;
      this.profileId = null;
      this.advertised.clear();
      this.reportConnectionError(
        new BrowserDispatchFailure(
          "UNAVAILABLE",
          "The browser profile disconnected.",
          { targetId: this.id },
        ),
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserDispatchFailure(
            "UNCERTAIN_OUTCOME",
            "The native Chromium connection ended after dispatch; inspect the same profile before retrying.",
            { targetId: this.id },
          ),
        );
      }
      this.pending.clear();
    });
  }

  private receive(input: unknown, post: (frame: unknown) => void): void {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid native browser message.");
    const message = input as Record<string, unknown>;
    if (message.type === "hello") {
      if (
        this.profileId ||
        (message.nonce !== undefined &&
          (typeof message.nonce !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce))) ||
        message.protocol !== 2 ||
        message.extensionId !== "pmldpcoefklbdbgmggcejkfoinmjfeio" ||
        typeof message.profileId !== "string" ||
        !Array.isArray(message.capabilities) ||
        !message.capabilities.every((value) => typeof value === "string")
      )
        throw new Error("Invalid native browser registration.");
      this.profileId = message.profileId;
      this.lastTransportDiagnostic = null;
      this.advertised = new Set(message.capabilities);
      if (typeof message.nonce === "string")
        post({
          type: "hello-ack",
          nonce: message.nonce,
          profileId: this.profileId,
        });
      return;
    }
    if (message.type === "ping") {
      if (
        !this.profileId ||
        message.profileId !== this.profileId ||
        typeof message.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(message.nonce)
      )
        throw new Error("Invalid native browser liveness probe.");
      post({ type: "pong", nonce: message.nonce, profileId: this.profileId });
      return;
    }
    if (
      !this.profileId ||
      message.type !== "result" ||
      typeof message.id !== "string"
    )
      throw new Error(
        "Native browser result arrived without profile registration.",
      );
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const error = message.error as
        | { kind?: string; message?: string }
        | undefined;
      const kind =
        error?.kind === "UNAVAILABLE"
          ? "UNAVAILABLE"
          : error?.kind === "STALE_REF"
            ? "STALE_REF"
            : error?.kind === "UNSUPPORTED"
              ? "UNSUPPORTED"
              : error?.kind === "POLICY_BLOCKED"
                ? "POLICY_BLOCKED"
                : "UNCERTAIN_OUTCOME";
      pending.reject(
        new BrowserDispatchFailure(
          kind,
          error?.message ?? "Native browser command failed.",
          { targetId: this.id },
        ),
      );
    }
  }

  private request(command: BrowserWorkspaceCommand): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.getProfileId() || !this.sender)
      return Promise.reject(
        new BrowserDispatchFailure(
          "UNAVAILABLE",
          "No registered Chromium profile is connected.",
          { targetId: this.id },
        ),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrowserDispatchFailure(
            "UNCERTAIN_OUTCOME",
            "Chromium did not acknowledge the request before the deadline; inspect the same tab before retrying.",
            { targetId: this.id },
          ),
        );
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      void this.sender
        ?.send({ type: "command", id, command })
        .catch((cause) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          reject(
            new BrowserDispatchFailure(
              "UNCERTAIN_OUTCOME",
              "The native command transport failed after dispatch; inspect the same profile before retrying.",
              { targetId: this.id, cause },
            ),
          );
          socket.destroy();
        });
    });
  }

  async execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> {
    if (!this.supports(command))
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "This Chromium profile does not support the requested command.",
        { targetId: this.id },
      );
    if (!command.id && !["open", "list"].includes(command.subaction)) {
      const listing = await this.request({ subaction: "list" });
      if (
        !listing ||
        typeof listing !== "object" ||
        !Array.isArray((listing as { tabs?: unknown }).tabs)
      )
        throw new Error("Invalid Chromium tab inventory.");
      const tabs = (
        listing as { tabs: Array<{ id?: unknown; active?: unknown }> }
      ).tabs.filter((tab) => tab.active === true && typeof tab.id === "string");
      if (tabs.length !== 1)
        throw new BrowserDispatchFailure(
          "UNSUPPORTED",
          "Select an explicit tab ID from list; the current profile has no unique active tab.",
          { targetId: this.id },
        );
      command = { ...command, id: String(tabs[0].id) };
    }
    const profileId = this.profileId;
    const result = await this.request(command);
    return {
      targetId: this.id,
      mode: "desktop",
      subaction: command.subaction,
      value: { profileId, result },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.destroy();
    if (this.server)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (this.ownedPath) await rm(this.ownedPath, { force: true });
  }
}
