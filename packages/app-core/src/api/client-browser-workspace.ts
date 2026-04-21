import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  NavigateBrowserWorkspaceTabRequest,
  OpenBrowserWorkspaceTabRequest,
} from "@elizaos/agent/services/browser-workspace";
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

ElizaClient.prototype.getBrowserWorkspace = async function (this: ElizaClient) {
  return this.fetch("/api/browser-workspace");
};

ElizaClient.prototype.openBrowserWorkspaceTab = async function (
  this: ElizaClient,
  request,
) {
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
  return this.fetch(`/api/browser-workspace/tabs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.snapshotBrowserWorkspaceTab = async function (
  this: ElizaClient,
  id,
) {
  return this.fetch(
    `/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`,
  );
};
