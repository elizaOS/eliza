import { readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { createRuntimeLspDefinitions, type RuntimeLspServerDefinition } from "./builtins";
import { createLspClientSession, type LspClientSession } from "./client";
import type { LspDiagnosticFile, LspQueryInput, LspToolResponse, NormalizedLspSettings } from "./types";

interface ManagedClient {
  key: string;
  definition: RuntimeLspServerDefinition;
  root: string;
  client: LspClientSession;
}

interface WorkspaceLspManagerOptions {
  createClient?: (input: {
    serverId: string;
    root: string;
    definition: RuntimeLspServerDefinition;
    settings: NormalizedLspSettings;
  }) => Promise<LspClientSession | null>;
}

export interface WorkspaceLspManager {
  touchFile(filePath: string, waitForDiagnostics?: boolean): Promise<LspDiagnosticFile[]>;
  syncFile(
    filePath: string,
    content: string,
    save?: boolean,
    waitForDiagnostics?: boolean,
  ): Promise<LspDiagnosticFile[]>;
  query(input: LspQueryInput): Promise<LspToolResponse>;
  close(): Promise<void>;
}

export function createWorkspaceLspManager(
  cwd: string,
  settings: NormalizedLspSettings,
  options: WorkspaceLspManagerOptions = {},
): WorkspaceLspManager {
  const definitions = createRuntimeLspDefinitions(cwd, settings);
  const clients = new Map<string, Promise<ManagedClient | null>>();

  const createClient =
    options.createClient ??
    (async ({ serverId, root, definition, settings: normalizedSettings }) => {
      const launch = await definition.resolveLaunch(root, normalizedSettings);
      if (!launch || !launch.command) return null;
      return createLspClientSession({
        serverId,
        root,
        launch,
        startupTimeoutMs: normalizedSettings.startupTimeoutMs,
        diagnosticsDebounceMs: normalizedSettings.diagnosticsDebounceMs,
      });
    });

  async function getClientsForFile(filePath: string): Promise<ManagedClient[]> {
    if (!settings.enabled) return [];

    const normalizedPath = path.resolve(filePath);
    const extension = path.extname(normalizedPath).toLowerCase();
    const matches = definitions.filter((definition) => definition.extensions.includes(extension));
    if (matches.length === 0) return [];

    const resolved = await Promise.all(
      matches.map(async (definition) => {
        const root = await definition.resolveRoot(normalizedPath, cwd);
        if (!root) return null;

        const cacheKey = `${definition.id}:${root}`;
        const inflight = clients.get(cacheKey);
        if (inflight) return inflight;

        const next = (async () => {
          const client = await createClient({
            serverId: definition.id,
            root,
            definition,
            settings,
          });
          if (!client) return null;
          return { key: cacheKey, definition, root, client };
        })();

        clients.set(cacheKey, next);
        try {
          const value = await next;
          if (!value) {
            clients.delete(cacheKey);
          }
          return value;
        } catch (err) {
          clients.delete(cacheKey);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[lsp] Failed to start ${definition.id} for ${cacheKey}: ${msg}`);
          return null;
        }
      }),
    );

    return resolved.filter((value): value is ManagedClient => value !== null);
  }

  async function touchFile(filePath: string, waitForDiagnostics = true): Promise<LspDiagnosticFile[]> {
    const content = await readFile(filePath, "utf8");
    return syncFile(filePath, content, false, waitForDiagnostics);
  }

  async function syncFile(
    filePath: string,
    content: string,
    save = true,
    waitForDiagnostics = true,
  ): Promise<LspDiagnosticFile[]> {
    const records = await getClientsForFile(filePath);
    if (records.length === 0) return [];

    const extension = path.extname(filePath).toLowerCase();
    const diagnostics = await Promise.all(
      records.map(async ({ key, definition, client }) => {
        const languageId = definition.languageIds[extension] ?? (extension.slice(1) || "plaintext");
        try {
          await client.openOrChangeFile(filePath, languageId, content);
          if (save) {
            await client.saveFile(filePath);
          }
          if (waitForDiagnostics) {
            await client.waitForDiagnostics(filePath);
          }
          return {
            filePath,
            serverId: client.serverId,
            diagnostics: client.getDiagnostics(filePath),
          };
        } catch {
          clients.delete(key);
          return null;
        }
      }),
    );

    return diagnostics.filter((entry): entry is LspDiagnosticFile => entry !== null && entry.diagnostics.length > 0);
  }

  async function query(input: LspQueryInput): Promise<LspToolResponse> {
    const normalizedPath = path.resolve(cwd, input.filePath);
    const records = await getClientsForFile(normalizedPath);
    if (records.length === 0) {
      return {
        success: false,
        output: `No LSP server available for ${path.extname(normalizedPath) || "this file type"}.`,
      };
    }

    const lspDiagnostics = await touchFile(normalizedPath, true);
    const params = createOperationParams(input, normalizedPath);
    const results = (
      await Promise.all(
        records.map(async ({ key, client }) => {
          if (input.operation === "incomingCalls" || input.operation === "outgoingCalls") {
            try {
              const items = await client.sendRequest<unknown[]>("textDocument/prepareCallHierarchy", params);
              const firstItem = Array.isArray(items) ? items[0] : undefined;
              if (!firstItem) return [];
              return client.sendRequest<unknown[]>(
                input.operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
                { item: firstItem },
              );
            } catch {
              clients.delete(key);
              return [];
            }
          }

          try {
            return await client.sendRequest<unknown>(getOperationMethod(input.operation), params);
          } catch {
            clients.delete(key);
            return [];
          }
        }),
      )
    )
      .flatMap((result) => (Array.isArray(result) ? result : result ? [result] : []))
      .filter(Boolean);

    const output = results.length > 0 ? JSON.stringify(results, null, 2) : `No results found for ${input.operation}.`;
    return {
      success: true,
      output,
      lspDiagnostics,
    };
  }

  async function close(): Promise<void> {
    const entries = await Promise.allSettled([...clients.values()]);
    const active = entries
      .filter((entry): entry is PromiseFulfilledResult<ManagedClient | null> => entry.status === "fulfilled")
      .map((entry) => entry.value)
      .filter((value): value is ManagedClient => value !== null);
    await Promise.allSettled(active.map((entry) => entry.client.stop()));
    clients.clear();
  }

  return {
    touchFile,
    syncFile,
    query,
    close,
  };
}

function getOperationMethod(operation: LspQueryInput["operation"]): string {
  switch (operation) {
    case "goToDefinition":
      return "textDocument/definition";
    case "findReferences":
      return "textDocument/references";
    case "hover":
      return "textDocument/hover";
    case "documentSymbol":
      return "textDocument/documentSymbol";
    case "workspaceSymbol":
      return "workspace/symbol";
    case "goToImplementation":
      return "textDocument/implementation";
    case "prepareCallHierarchy":
      return "textDocument/prepareCallHierarchy";
    case "incomingCalls":
    case "outgoingCalls":
      return "textDocument/prepareCallHierarchy";
  }
}

function createOperationParams(input: LspQueryInput, absolutePath: string): Record<string, unknown> {
  const uri = pathToFileURL(absolutePath).href;
  const position = {
    line: (input.line ?? 1) - 1,
    character: (input.character ?? 1) - 1,
  };

  switch (input.operation) {
    case "goToDefinition":
    case "hover":
    case "goToImplementation":
    case "prepareCallHierarchy":
    case "incomingCalls":
    case "outgoingCalls":
      return {
        textDocument: { uri },
        position,
      };
    case "findReferences":
      return {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      };
    case "documentSymbol":
      return {
        textDocument: { uri },
      };
    case "workspaceSymbol":
      return {
        query: input.query ?? "",
      };
  }
}

export function summarizeLspDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  const counts = diagnostics
    .flatMap((entry) => entry.diagnostics)
    .reduce(
      (acc, diagnostic) => {
        const severity = diagnostic.severity ?? 1;
        if (severity === 1) acc.errors += 1;
        else if (severity === 2) acc.warnings += 1;
        else acc.infos += 1;
        return acc;
      },
      { errors: 0, warnings: 0, infos: 0 },
    );

  const total = counts.errors + counts.warnings + counts.infos;
  if (total === 0) return null;

  const parts = [`${total} LSP issue${total === 1 ? "" : "s"}`];
  if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
  if (counts.infos > 0) parts.push(`${counts.infos} info`);
  return parts.join(" · ");
}
