import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import type { LspDiagnostic, LspLaunchSpec } from "./types";

export interface LspClientOptions {
  serverId: string;
  root: string;
  launch: LspLaunchSpec;
  startupTimeoutMs: number;
  diagnosticsDebounceMs: number;
}

export interface LspClientSession {
  readonly serverId: string;
  readonly root: string;
  openOrChangeFile(filePath: string, languageId: string, text: string): Promise<void>;
  saveFile(filePath: string): Promise<void>;
  closeFile(filePath: string): Promise<void>;
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;
  waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<LspDiagnostic[]>;
  getDiagnostics(filePath: string): LspDiagnostic[];
  stop(): Promise<void>;
}

interface DiagnosticWaiter {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export async function createLspClientSession(options: LspClientOptions): Promise<LspClientSession> {
  const childProcess = await spawnProcess(options.launch, options.root);
  const connection = createConnection(childProcess);
  const versions = new Map<string, number>();
  const diagnostics = new Map<string, LspDiagnostic[]>();
  const waiters = new Map<string, DiagnosticWaiter[]>();
  let stopped = false;

  if (childProcess.stderr) {
    childProcess.stderr.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[lsp:${options.serverId}:stderr] ${output}`);
      }
    });
  }

  childProcess.on("exit", (code) => {
    if (code !== 0 && code !== null && !stopped) {
      console.error(`[lsp:${options.serverId}] process exited with code ${code}`);
    }
  });

  connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
    const filePath = normalizeUriPath(params.uri);
    diagnostics.set(filePath, params.diagnostics.map(normalizeDiagnostic));
    const listeners = waiters.get(filePath) ?? [];
    for (const waiter of listeners) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = setTimeout(waiter.resolve, options.diagnosticsDebounceMs);
    }
  });

  connection.onRequest("workspace/configuration", async () => [options.launch.initializationOptions ?? {}]);
  connection.onRequest("window/workDoneProgress/create", async () => null);
  connection.onRequest("client/registerCapability", async () => null);
  connection.onRequest("client/unregisterCapability", async () => null);
  connection.listen();

  try {
    await withTimeout(
      connection.sendRequest("initialize", {
        processId: childProcess.pid,
        rootUri: pathToFileURL(options.root).href,
        rootPath: options.root,
        workspaceFolders: [
          {
            uri: pathToFileURL(options.root).href,
            name: options.root.split(/[\\/]/).pop() || "workspace",
          },
        ],
        initializationOptions: options.launch.initializationOptions ?? {},
        capabilities: {
          workspace: {
            configuration: true,
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
              didSave: true,
              willSave: false,
              willSaveWaitUntil: false,
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true,
            },
            definition: {
              linkSupport: true,
            },
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
            positionEncodings: ["utf-16"],
          },
        },
      }),
      options.startupTimeoutMs,
      `LSP server "${options.serverId}" timed out during initialization`,
    );

    await connection.sendNotification("initialized", {});
  } catch (error) {
    connection.dispose();
    try {
      childProcess.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    throw error;
  }

  return {
    serverId: options.serverId,
    root: options.root,
    async openOrChangeFile(filePath, languageId, text) {
      ensureActive(stopped, options.serverId);
      const normalizedPath = normalizeFsPath(filePath);
      const uri = pathToFileURL(normalizedPath).href;
      const version = versions.get(normalizedPath);

      diagnostics.delete(normalizedPath);

      if (version === undefined) {
        versions.set(normalizedPath, 0);
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId,
            version: 0,
            text,
          },
        });
        return;
      }

      const nextVersion = version + 1;
      versions.set(normalizedPath, nextVersion);
      await connection.sendNotification("textDocument/didChange", {
        textDocument: {
          uri,
          version: nextVersion,
        },
        contentChanges: [{ text }],
      });
    },
    async saveFile(filePath) {
      ensureActive(stopped, options.serverId);
      const normalizedPath = normalizeFsPath(filePath);
      if (!versions.has(normalizedPath)) return;
      await connection.sendNotification("textDocument/didSave", {
        textDocument: {
          uri: pathToFileURL(normalizedPath).href,
        },
      });
    },
    async closeFile(filePath) {
      ensureActive(stopped, options.serverId);
      const normalizedPath = normalizeFsPath(filePath);
      if (!versions.has(normalizedPath)) return;
      versions.delete(normalizedPath);
      await connection.sendNotification("textDocument/didClose", {
        textDocument: {
          uri: pathToFileURL(normalizedPath).href,
        },
      });
    },
    async sendRequest<_TResult>(method: string, params: unknown) {
      ensureActive(stopped, options.serverId);
      return connection.sendRequest(method, params);
    },
    async waitForDiagnostics(filePath, timeoutMs = 1_500) {
      const normalizedPath = normalizeFsPath(filePath);
      if (diagnostics.has(normalizedPath)) {
        return diagnostics.get(normalizedPath) ?? [];
      }

      await new Promise<void>((resolve) => {
        const entry: DiagnosticWaiter = {
          resolve: () => {
            cleanup();
            resolve();
          },
        };
        const cleanup = () => {
          const next = (waiters.get(normalizedPath) ?? []).filter((item) => item !== entry);
          if (next.length === 0) waiters.delete(normalizedPath);
          else waiters.set(normalizedPath, next);
        };

        const fallback = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);

        const originalResolve = entry.resolve;
        entry.resolve = () => {
          clearTimeout(fallback);
          originalResolve();
        };

        waiters.set(normalizedPath, [...(waiters.get(normalizedPath) ?? []), entry]);
      });

      return diagnostics.get(normalizedPath) ?? [];
    },
    getDiagnostics(filePath) {
      return diagnostics.get(normalizeFsPath(filePath)) ?? [];
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await connection.sendRequest("shutdown");
      } catch {
        // Some servers exit before responding to shutdown.
      }
      try {
        await connection.sendNotification("exit", {});
      } catch {
        // Best-effort during shutdown.
      }
      connection.dispose();
      try {
        childProcess.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
    },
  };
}

function createConnection(process: ChildProcessWithoutNullStreams): MessageConnection {
  return createMessageConnection(new StreamMessageReader(process.stdout), new StreamMessageWriter(process.stdin));
}

async function spawnProcess(launch: LspLaunchSpec, cwd: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(launch.command, launch.args ?? [], {
    cwd,
    env: {
      ...globalThis.process.env,
      ...launch.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  return child;
}

function normalizeDiagnostic(input: Diagnostic): LspDiagnostic {
  return {
    message: typeof input.message === "string" ? input.message : String(input.message),
    severity: input.severity,
    source: input.source,
    code: input.code !== undefined ? String(input.code) : undefined,
    range: {
      start: {
        line: input.range.start.line,
        character: input.range.start.character,
      },
      end: {
        line: input.range.end.line,
        character: input.range.end.character,
      },
    },
  };
}

function normalizeUriPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return normalizeFsPath(fileURLToPath(uri));
  }
  return normalizeFsPath(uri);
}

function normalizeFsPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function ensureActive(stopped: boolean, serverId: string): void {
  if (stopped) {
    throw new Error(`LSP client "${serverId}" is already stopped.`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = "Timed out"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
