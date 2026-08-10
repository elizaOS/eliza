/**
 * Platform-neutral Browser workspace client. Every host uses the same tab and
 * session contract; Electrobun selects native RPC while web and mobile use the
 * workspace HTTP transport.
 */
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import type {
  BrowserWorkspaceFrame,
  BrowserWorkspaceInput,
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  BrowserWorkspaceViewport,
  NavigateBrowserWorkspaceTabRequest,
  OpenBrowserWorkspaceTabRequest,
} from "./browser-contracts";
import { ElizaClient } from "./client-base";

export interface BrowserWorkspaceFrameSubscription {
  close(): Promise<void>;
  done: Promise<void>;
}

declare module "./client-base" {
  interface ElizaClient {
    getBrowserWorkspace(): Promise<BrowserWorkspaceSnapshot>;
    openBrowserWorkspaceTab(request: OpenBrowserWorkspaceTabRequest): Promise<{
      tab: BrowserWorkspaceTab;
    }>;
    navigateBrowserWorkspaceTab(
      id: string,
      url: string,
    ): Promise<{ tab: BrowserWorkspaceTab }>;
    showBrowserWorkspaceTab(id: string): Promise<{ tab: BrowserWorkspaceTab }>;
    hideBrowserWorkspaceTab(id: string): Promise<{ tab: BrowserWorkspaceTab }>;
    closeBrowserWorkspaceTab(id: string): Promise<{ closed: boolean }>;
    snapshotBrowserWorkspaceTab(id: string): Promise<{ data: string }>;
    streamBrowserWorkspaceTabFrames(
      id: string,
      onFrame: (frame: BrowserWorkspaceFrame) => void,
    ): Promise<BrowserWorkspaceFrameSubscription>;
    sendBrowserWorkspaceInput(
      id: string,
      input: BrowserWorkspaceInput,
    ): Promise<{ ok: true }>;
    resizeBrowserWorkspaceTab(
      id: string,
      viewport: BrowserWorkspaceViewport,
    ): Promise<{ ok: true }>;
  }
}

async function requestDesktopBrowserWorkspace<T>(options: {
  rpcMethod: string;
  ipcChannel: string;
  params?: unknown;
}): Promise<T | null> {
  if (!isElectrobunRuntime()) {
    return null;
  }

  return invokeDesktopBridgeRequest<T>(options);
}

ElizaClient.prototype.getBrowserWorkspace = async function (this: ElizaClient) {
  const bridged =
    await requestDesktopBrowserWorkspace<BrowserWorkspaceSnapshot>({
      rpcMethod: "browserWorkspaceGetSnapshot",
      ipcChannel: "browser-workspace:getSnapshot",
    });
  if (bridged) {
    return bridged;
  }

  return this.fetch("/api/browser-workspace");
};

ElizaClient.prototype.openBrowserWorkspaceTab = async function (
  this: ElizaClient,
  request,
) {
  const bridged = await requestDesktopBrowserWorkspace<{
    tab: BrowserWorkspaceTab;
  }>({
    rpcMethod: "browserWorkspaceOpenTab",
    ipcChannel: "browser-workspace:openTab",
    params: request,
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch("/api/browser-workspace/tabs", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.navigateBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
  url,
) {
  const params = { id, url } satisfies NavigateBrowserWorkspaceTabRequest;
  const bridged = await requestDesktopBrowserWorkspace<{
    tab: BrowserWorkspaceTab;
  }>({
    rpcMethod: "browserWorkspaceNavigateTab",
    ipcChannel: "browser-workspace:navigateTab",
    params,
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/navigate`,
    {
      method: "POST",
      body: JSON.stringify({ url } satisfies Pick<
        NavigateBrowserWorkspaceTabRequest,
        "url"
      >),
    },
  );
};

ElizaClient.prototype.showBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
) {
  const bridged = await requestDesktopBrowserWorkspace<{
    tab: BrowserWorkspaceTab;
  }>({
    rpcMethod: "browserWorkspaceShowTab",
    ipcChannel: "browser-workspace:showTab",
    params: { id },
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/show`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.hideBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
) {
  const bridged = await requestDesktopBrowserWorkspace<{
    tab: BrowserWorkspaceTab;
  }>({
    rpcMethod: "browserWorkspaceHideTab",
    ipcChannel: "browser-workspace:hideTab",
    params: { id },
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/hide`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.closeBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
) {
  const bridged = await requestDesktopBrowserWorkspace<{ closed: boolean }>({
    rpcMethod: "browserWorkspaceCloseTab",
    ipcChannel: "browser-workspace:closeTab",
    params: { id },
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.snapshotBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
) {
  const bridged = await requestDesktopBrowserWorkspace<{ data: string }>({
    rpcMethod: "browserWorkspaceSnapshotTab",
    ipcChannel: "browser-workspace:snapshotTab",
    params: { id },
  });
  if (bridged) {
    return bridged;
  }

  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`,
  );
};

function isBrowserWorkspaceFrame(
  value: unknown,
): value is BrowserWorkspaceFrame {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "frame" &&
    typeof record.data === "string" &&
    typeof record.width === "number" &&
    Number.isFinite(record.width) &&
    typeof record.height === "number" &&
    Number.isFinite(record.height) &&
    typeof record.timestamp === "number" &&
    Number.isFinite(record.timestamp)
  );
}

ElizaClient.prototype.streamBrowserWorkspaceTabFrames = async function (
  this: ElizaClient,
  id,
  onFrame,
) {
  const response = await this.rawRequest(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/frames`,
  );
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Browser frame stream did not provide a response body.");
  }

  let closed = false;
  const decoder = new TextDecoder();
  const done = (async (): Promise<void> => {
    let buffered = "";
    while (!closed) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed: unknown = JSON.parse(trimmed);
        if (isBrowserWorkspaceFrame(parsed)) onFrame(parsed);
      }
    }
  })();

  return {
    done,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await reader.cancel();
    },
  };
};

ElizaClient.prototype.sendBrowserWorkspaceInput = async function (
  this: ElizaClient,
  id,
  input,
) {
  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/input`,
    {
      method: "POST",
      body: JSON.stringify({ input }),
    },
  );
};

ElizaClient.prototype.resizeBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
  viewport,
) {
  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/viewport`,
    {
      method: "POST",
      body: JSON.stringify({ viewport }),
    },
  );
};
