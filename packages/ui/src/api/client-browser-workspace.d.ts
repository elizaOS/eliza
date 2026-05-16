import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  OpenBrowserWorkspaceTabRequest,
} from "./browser-contracts";

declare module "./client-base" {
  interface ElizaClient {
    getBrowserWorkspace(): Promise<BrowserWorkspaceSnapshot>;
    openBrowserWorkspaceTab(request: OpenBrowserWorkspaceTabRequest): Promise<{
      tab: BrowserWorkspaceTab;
    }>;
    navigateBrowserWorkspaceTab(
      id: string,
      url: string,
    ): Promise<{
      tab: BrowserWorkspaceTab;
    }>;
    showBrowserWorkspaceTab(id: string): Promise<{
      tab: BrowserWorkspaceTab;
    }>;
    hideBrowserWorkspaceTab(id: string): Promise<{
      tab: BrowserWorkspaceTab;
    }>;
    closeBrowserWorkspaceTab(id: string): Promise<{
      closed: boolean;
    }>;
    snapshotBrowserWorkspaceTab(id: string): Promise<{
      data: string;
    }>;
  }
}
//# sourceMappingURL=client-browser-workspace.d.ts.map
