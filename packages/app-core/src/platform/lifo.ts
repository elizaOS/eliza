import { client } from "../api/client";

export const LIFO_SYNC_CHANNEL_PREFIX = "eliza-lifo-sync";

type LocationLike = {
  search?: string;
  hash?: string;
};

export interface LifoTerminal {
  write(data: string): void;
  writeln(data: string): void;
  dispose(): void;
}

export interface LifoExplorer {
  refresh(): void;
  destroy(): void;
}

export interface LifoRuntime {
  terminal: LifoTerminal;
  explorer: LifoExplorer;
  shell: {
    execute(
      command: string,
      options?: {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      },
    ): Promise<{ exitCode: number }>;
  };
}

export interface BuildLifoPopoutUrlArgs {
  baseUrl: string;
  sessionId?: string | null;
  targetPath?: string;
}

export interface LifoSyncMessage {
  source: "controller" | "watcher";
  type:
    | "heartbeat"
    | "session-reset"
    | "command-start"
    | "stdout"
    | "stderr"
    | "command-exit"
    | "command-error";
  command?: string;
  chunk?: string;
  exitCode?: number;
  message?: string;
}

function parseSearchParams(raw: string): URLSearchParams {
  const trimmed = raw.trim();
  const search = trimmed.startsWith("?")
    ? trimmed
    : trimmed.includes("?")
      ? trimmed.slice(trimmed.indexOf("?"))
      : "";
  return new URLSearchParams(search);
}

function parseLocationParams(locationLike: LocationLike): {
  search: URLSearchParams;
  hash: URLSearchParams;
} {
  return {
    search: parseSearchParams(locationLike.search ?? ""),
    hash: parseSearchParams(locationLike.hash ?? ""),
  };
}

export function isLifoPopoutValue(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "1" ||
    normalized === "true" ||
    normalized === "lifo"
  );
}

export function getPopoutValueFromLocation(
  locationLike: LocationLike,
): string | null {
  const { search, hash } = parseLocationParams(locationLike);
  return search.get("popout") ?? hash.get("popout");
}

export function isLifoPopoutModeAtLocation(
  locationLike: LocationLike,
): boolean {
  return isLifoPopoutValue(getPopoutValueFromLocation(locationLike));
}

export function getLifoSessionIdFromLocation(
  locationLike: LocationLike,
): string | null {
  const { search, hash } = parseLocationParams(locationLike);
  return search.get("lifoSession") ?? hash.get("lifoSession");
}

export function buildLifoPopoutUrl({
  baseUrl,
  sessionId,
  targetPath = "/lifo",
}: BuildLifoPopoutUrlArgs): string {
  const url = new URL(baseUrl);
  url.pathname = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  url.searchParams.set("popout", "lifo");
  if (sessionId?.trim()) {
    url.searchParams.set("lifoSession", sessionId.trim());
  }
  return url.toString();
}

export function generateLifoSessionId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function getLifoSyncChannelName(sessionId: string | null): string {
  return sessionId?.trim()
    ? `${LIFO_SYNC_CHANNEL_PREFIX}-${sessionId.trim()}`
    : LIFO_SYNC_CHANNEL_PREFIX;
}

export function isSafeEndpointUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeTerminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

class DomTerminal implements LifoTerminal {
  private readonly output: HTMLPreElement;

  constructor(private readonly host: HTMLElement) {
    this.output = document.createElement("pre");
    this.output.className =
      "m-0 h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-[var(--txt,#fff)]";
    this.host.replaceChildren(this.output);
  }

  write(data: string): void {
    this.output.textContent = `${this.output.textContent ?? ""}${data}`;
    this.host.scrollTop = this.host.scrollHeight;
  }

  writeln(data: string): void {
    this.write(`${data}\n`);
  }

  dispose(): void {
    this.host.replaceChildren();
  }
}

class DomExplorer implements LifoExplorer {
  private readonly panel: HTMLDivElement;

  constructor(private readonly host: HTMLElement) {
    this.panel = document.createElement("div");
    this.panel.className =
      "h-full overflow-auto p-3 text-xs text-[var(--muted,#a1a1aa)]";
    this.host.replaceChildren(this.panel);
    this.refresh();
  }

  refresh(): void {
    this.panel.textContent = `Sandbox explorer attached\nLast refresh: ${new Date().toLocaleTimeString()}`;
  }

  destroy(): void {
    this.host.replaceChildren();
  }
}

export async function createLifoRuntime(
  terminalElement: HTMLElement,
  explorerElement: HTMLElement,
): Promise<LifoRuntime> {
  const terminal = new DomTerminal(terminalElement);
  const explorer = new DomExplorer(explorerElement);

  return {
    terminal,
    explorer,
    shell: {
      async execute(command, options) {
        try {
          await client.runTerminalCommand(command);
          options?.onStdout?.("Command dispatched to sandbox runtime.\n");
          return { exitCode: 0 };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          options?.onStderr?.(`${message}\n`);
          throw error;
        }
      },
    },
  };
}
