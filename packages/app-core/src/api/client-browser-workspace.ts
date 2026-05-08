import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  NavigateBrowserWorkspaceTabRequest,
  OpenBrowserWorkspaceTabRequest,
} from "@elizaos/plugin-browser/workspace";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { ElizaClient } from "./client-base";

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
