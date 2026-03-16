import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ComputerUseBackendName,
  type ComputerUseConfig,
  computerUseConfigSchema,
  type JsonObject,
} from "../types.js";

// Runtime service shape (from @elizaos/plugin-mcp), referenced structurally to avoid a hard dep.
interface McpServiceLike extends Service {
  callTool(
    serverName: string,
    toolName: string,
    toolArguments?: Readonly<JsonObject>
  ): Promise<CallToolResult>;
  getServers(): ReadonlyArray<{ name: string; status: string }>;
}

export class ComputerUseService extends Service {
  static serviceType = "computeruse";
  capabilityDescription =
    "Enables the agent to control a computer UI locally (when supported) or via a ComputerUse MCP server";

  private computeruseConfig: ComputerUseConfig;
  private backendName: ComputerUseBackendName | null = null;
  private initialized = false;

  // Lazy-loaded to avoid importing native bindings unless actually used.
  private localDesktop: import("@elizaos/computeruse").Desktop | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.computeruseConfig = computerUseConfigSchema.parse({
      COMPUTERUSE_ENABLED: String(process.env.COMPUTERUSE_ENABLED ?? "false"),
      COMPUTERUSE_MODE: String(process.env.COMPUTERUSE_MODE ?? "auto"),
      COMPUTERUSE_MCP_SERVER: String(process.env.COMPUTERUSE_MCP_SERVER ?? "computeruse"),
    });
  }

  static async start(runtime: IAgentRuntime): Promise<ComputerUseService> {
    const service = new ComputerUseService(runtime);
    return service;
  }

  async stop(): Promise<void> {
    this.localDesktop = null;
    this.backendName = null;
    this.initialized = false;
  }

  getMode(): ComputerUseConfig["COMPUTERUSE_MODE"] {
    return this.computeruseConfig.COMPUTERUSE_MODE;
  }

  getBackendName(): ComputerUseBackendName | null {
    return this.backendName;
  }

  getMcpServerName(): string {
    return this.computeruseConfig.COMPUTERUSE_MCP_SERVER;
  }

  isEnabled(): boolean {
    return this.computeruseConfig.COMPUTERUSE_ENABLED;
  }

  async ensureReady(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.initializeBackend();
  }

  private async initializeBackend(): Promise<void> {
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) {
      logger.info("[computeruse] disabled (COMPUTERUSE_ENABLED=false)");
      this.backendName = null;
      return;
    }

    const mode = this.computeruseConfig.COMPUTERUSE_MODE;
    if (mode === "local") {
      await this.ensureLocalBackend();
      this.backendName = "local";
      return;
    }
    if (mode === "mcp") {
      await this.ensureMcpBackend();
      this.backendName = "mcp";
      return;
    }

    // auto - try local on all platforms, fall back to MCP
    try {
      await this.ensureLocalBackend();
      this.backendName = "local";
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[computeruse] local backend unavailable, falling back to mcp: ${msg}`);
    }

    await this.ensureMcpBackend();
    this.backendName = "mcp";
  }

  private async ensureLocalBackend(): Promise<void> {
    if (this.localDesktop) return;

    // Import only when needed (native optional deps).
    try {
      const mod = await import("@elizaos/computeruse");
      this.localDesktop = new mod.Desktop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const platform = process.platform;
      if (platform === "darwin") {
        throw new Error(
          `macOS native bindings not available: ${msg}. Use MCP mode or ensure @elizaos/computeruse-darwin-* is installed.`
        );
      } else if (platform === "linux") {
        throw new Error(
          `Linux native bindings not available: ${msg}. Use MCP mode or ensure @elizaos/computeruse-linux-* is installed.`
        );
      }
      throw err;
    }
  }

  private async ensureMcpBackend(): Promise<void> {
    const mcp = await this.waitForMcpService();

    const serverName = this.computeruseConfig.COMPUTERUSE_MCP_SERVER;
    const servers = mcp.getServers();
    const exists = servers.some((s) => s.name === serverName);
    if (!exists) {
      throw new Error(
        `MCP server "${serverName}" not configured. Add it under runtime/character settings "mcp.servers".`
      );
    }
  }

  private async waitForMcpService(): Promise<McpServiceLike> {
    // Services are registered during runtime initialization; depending on plugin order,
    // "mcp" may not be available during another service's start hook.
    for (let attempt = 0; attempt < 20; attempt++) {
      const mcp = this.runtime.getService<McpServiceLike>("mcp");
      if (mcp) return mcp;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      "MCP service not available. Add @elizaos/plugin-mcp and configure a computeruse server."
    );
  }

  private getMcp(): McpServiceLike {
    const mcp = this.runtime.getService<McpServiceLike>("mcp");
    if (!mcp) {
      throw new Error("MCP service not available");
    }
    return mcp;
  }

  private parseProcessScopedSelector(
    rawSelector: string,
    processHint?: string
  ): { process: string; selector: string } {
    const selector = rawSelector.trim();
    const match = selector.match(/^\s*process:([^\s>]+)\s*(?:>>\s*(.*))?$/);
    if (match) {
      const process = match[1]?.trim();
      const inner = (match[2] ?? "").trim();
      if (!process) {
        throw new Error(
          "Missing process. Provide parameters.process or prefix selector with 'process:<name> >> ...'"
        );
      }
      return { process, selector: inner };
    }

    const process = processHint?.trim();
    if (!process) {
      throw new Error(
        "Missing process. Provide parameters.process or prefix selector with 'process:<name> >> ...'"
      );
    }
    return { process, selector };
  }

  async openApplication(appName: string): Promise<void> {
    await this.ensureReady();
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) throw new Error("ComputerUse is disabled");

    if (this.backendName === "local") {
      await this.ensureLocalBackend();
      this.localDesktop?.openApplication(appName);
      return;
    }

    if (this.backendName === "mcp") {
      const mcp = this.getMcp();
      await mcp.callTool(this.computeruseConfig.COMPUTERUSE_MCP_SERVER, "open_application", {
        app_name: appName,
        verify_element_exists: "",
        verify_element_not_exists: "",
        include_tree_after_action: false,
      });
      return;
    }

    throw new Error("ComputerUse backend not initialized");
  }

  async click(selector: string, timeoutMs: number, process?: string): Promise<void> {
    await this.ensureReady();
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) throw new Error("ComputerUse is disabled");

    if (this.backendName === "local") {
      await this.ensureLocalBackend();
      const el = await this.localDesktop?.locator(selector).first(timeoutMs);
      if (!el) throw new Error(`Element not found: ${selector}`);
      await el.click();
      return;
    }

    if (this.backendName === "mcp") {
      const mcp = this.getMcp();
      const parsed = this.parseProcessScopedSelector(selector, process);
      await mcp.callTool(this.computeruseConfig.COMPUTERUSE_MCP_SERVER, "click_element", {
        process: parsed.process,
        selector: parsed.selector,
        timeout_ms: timeoutMs,
        verify_element_exists: "",
        verify_element_not_exists: "",
        highlight_before_action: false,
        ui_diff_before_after: false,
      });
      return;
    }

    throw new Error("ComputerUse backend not initialized");
  }

  async typeText(
    selector: string,
    text: string,
    timeoutMs: number,
    clearBeforeTyping: boolean,
    process?: string
  ): Promise<void> {
    await this.ensureReady();
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) throw new Error("ComputerUse is disabled");

    if (this.backendName === "local") {
      await this.ensureLocalBackend();
      const el = await this.localDesktop?.locator(selector).first(timeoutMs);
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.typeText(text, { clearBeforeTyping });
      return;
    }

    if (this.backendName === "mcp") {
      const mcp = this.getMcp();
      const parsed = this.parseProcessScopedSelector(selector, process);
      await mcp.callTool(this.computeruseConfig.COMPUTERUSE_MCP_SERVER, "type_into_element", {
        process: parsed.process,
        selector: parsed.selector,
        text_to_type: text,
        timeout_ms: timeoutMs,
        clear_before_typing: clearBeforeTyping,
        highlight_before_action: false,
        ui_diff_before_after: false,
      });
      return;
    }

    throw new Error("ComputerUse backend not initialized");
  }

  async getWindowTree(process: string, title?: string, maxDepth?: number): Promise<string> {
    await this.ensureReady();
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) throw new Error("ComputerUse is disabled");

    if (this.backendName === "local") {
      await this.ensureLocalBackend();
      const tree = this.localDesktop?.getWindowTree(process, title, undefined);
      return JSON.stringify(tree ?? null, null, 2);
    }

    if (this.backendName === "mcp") {
      const mcp = this.getMcp();
      const toolArgs: JsonObject = {
        process,
        include_tree_after_action: true,
      };
      if (title !== undefined) toolArgs.title = title;
      if (maxDepth !== undefined) toolArgs.tree_max_depth = maxDepth;
      const res = await mcp.callTool(
        this.computeruseConfig.COMPUTERUSE_MCP_SERVER,
        "get_window_tree",
        toolArgs
      );
      const texts = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .filter((t) => typeof t === "string");
      return texts.join("\n");
    }

    throw new Error("ComputerUse backend not initialized");
  }

  async getApplications(): Promise<string[]> {
    await this.ensureReady();
    if (!this.computeruseConfig.COMPUTERUSE_ENABLED) throw new Error("ComputerUse is disabled");

    if (this.backendName === "local") {
      await this.ensureLocalBackend();
      const apps = this.localDesktop?.applications() ?? [];
      // Normalize into human-readable names.
      const names: string[] = [];
      for (const app of apps) {
        const n = app.name();
        if (typeof n === "string" && n.trim().length > 0) names.push(n);
      }
      return names;
    }

    if (this.backendName === "mcp") {
      const mcp = this.getMcp();
      const res = await mcp.callTool(
        this.computeruseConfig.COMPUTERUSE_MCP_SERVER,
        "get_applications_and_windows_list",
        {}
      );
      // Return text-only summary for now; structured parsing is done in actions/providers if needed.
      const texts = res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .filter((t) => typeof t === "string");
      return texts.length > 0 ? texts : ["(see MCP tool output)"];
    }

    throw new Error("ComputerUse backend not initialized");
  }
}
