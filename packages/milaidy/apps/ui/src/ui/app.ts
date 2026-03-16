/**
 * Main Milaidy App component.
 *
 * Single-agent dashboard with onboarding wizard, chat, plugins, skills,
 * config, and logs views.
 */

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  client,
  type AgentStatus,
  type ChatMessage,
  type PluginInfo,
  type SkillInfo,
  type LogEntry,
  type OnboardingOptions,
} from "./api-client.js";
import { tabFromPath, pathForTab, type Tab, TAB_GROUPS, titleForTab } from "./navigation.js";

@customElement("milaidy-app")
export class MilaidyApp extends LitElement {
  // --- State ---
  @state() tab: Tab = "chat";
  @state() connected = false;
  @state() agentStatus: AgentStatus | null = null;
  @state() onboardingComplete = false;
  @state() onboardingLoading = true;
  @state() chatMessages: ChatMessage[] = [];
  @state() chatInput = "";
  @state() chatSending = false;
  @state() plugins: PluginInfo[] = [];
  @state() pluginFilter: "all" | "provider" | "channel" | "feature" | "core" = "all";
  @state() skills: SkillInfo[] = [];
  @state() logs: LogEntry[] = [];
  @state() autonomyEnabled = false;
  @state() configRaw: Record<string, unknown> = {};
  @state() configText = "";

  // Onboarding wizard state
  @state() onboardingStep = 0;
  @state() onboardingOptions: OnboardingOptions | null = null;
  @state() onboardingName = "";
  @state() onboardingStyle = "";
  @state() onboardingProvider = "";
  @state() onboardingApiKey = "";
  @state() onboardingTelegramToken = "";
  @state() onboardingDiscordToken = "";

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      font-family: var(--font-body);
      color: var(--text);
      background: var(--bg);
    }

    /* Layout */
    .app-shell {
      max-width: 900px;
      margin: 0 auto;
      padding: 0 20px;
    }

    /* Header */
    header {
      border-bottom: 1px solid var(--border);
      padding: 16px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      font-size: 18px;
      font-weight: bold;
      color: var(--text-strong);
      text-decoration: none;
    }

    .logo:hover {
      color: var(--accent);
      text-decoration: none;
    }

    .status-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
    }

    .status-pill {
      padding: 2px 10px;
      border: 1px solid var(--border);
      font-size: 12px;
      font-family: var(--mono);
    }

    .status-pill.running { border-color: var(--ok); color: var(--ok); }
    .status-pill.paused { border-color: var(--warn); color: var(--warn); }
    .status-pill.stopped { border-color: var(--muted); color: var(--muted); }

    .lifecycle-btn {
      padding: 4px 12px;
      border: 1px solid var(--border);
      background: var(--bg);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--mono);
    }

    .lifecycle-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Navigation */
    nav {
      border-bottom: 1px solid var(--border);
      padding: 8px 0;
    }

    nav a {
      display: inline-block;
      padding: 4px 12px;
      margin-right: 4px;
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      border-bottom: 2px solid transparent;
    }

    nav a:hover {
      color: var(--text);
      text-decoration: none;
    }

    nav a.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    /* Main content */
    main {
      padding: 24px 0;
      min-height: 60vh;
    }

    h2 {
      font-size: 18px;
      font-weight: normal;
      margin: 0 0 8px 0;
      color: var(--text-strong);
    }

    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 20px;
    }

    /* Footer */
    footer {
      border-top: 1px solid var(--border);
      padding: 16px 0;
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }

    /* Onboarding */
    .onboarding {
      max-width: 500px;
      margin: 40px auto;
      text-align: center;
    }

    .onboarding h1 {
      font-size: 24px;
      font-weight: normal;
      margin-bottom: 8px;
    }

    .onboarding p {
      color: var(--muted);
      margin-bottom: 24px;
    }

    .onboarding-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: left;
    }

    .onboarding-option {
      padding: 12px 16px;
      border: 1px solid var(--border);
      cursor: pointer;
      background: var(--card);
    }

    .onboarding-option:hover {
      border-color: var(--accent);
    }

    .onboarding-option.selected {
      border-color: var(--accent);
      background: var(--accent-subtle);
    }

    .onboarding-option .label {
      font-weight: bold;
      font-size: 14px;
    }

    .onboarding-option .hint {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }

    .onboarding-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--border);
      background: var(--card);
      font-size: 14px;
      margin-top: 8px;
    }

    .onboarding-input:focus {
      border-color: var(--accent);
      outline: none;
    }

    .btn {
      padding: 8px 24px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--accent-foreground);
      cursor: pointer;
      font-size: 14px;
      margin-top: 20px;
    }

    .btn:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .btn-outline {
      background: transparent;
      color: var(--accent);
    }

    .btn-outline:hover {
      background: var(--accent-subtle);
    }

    .btn-row {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-top: 20px;
    }

    /* Chat */
    .chat-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 200px);
      min-height: 400px;
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }

    .chat-msg {
      margin-bottom: 16px;
      line-height: 1.6;
    }

    .chat-msg .role {
      font-weight: bold;
      font-size: 13px;
      color: var(--muted-strong);
      margin-bottom: 2px;
    }

    .chat-msg.user .role { color: var(--text-strong); }
    .chat-msg.assistant .role { color: var(--accent); }

    .chat-input-row {
      display: flex;
      gap: 8px;
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }

    .chat-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--border);
      background: var(--card);
      font-size: 14px;
    }

    .chat-input:focus {
      border-color: var(--accent);
      outline: none;
    }

    .start-agent-box {
      text-align: center;
      padding: 40px;
      border: 1px solid var(--border);
      margin-top: 20px;
    }

    .start-agent-box p {
      color: var(--muted);
      margin-bottom: 16px;
    }

    /* Config */
    .config-editor {
      font-family: var(--mono);
      font-size: 13px;
      width: 100%;
      min-height: 400px;
      padding: 12px;
      border: 1px solid var(--border);
      background: var(--card);
      resize: vertical;
    }

    /* Plugin list */
    .plugin-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .plugin-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border: 1px solid var(--border);
      background: var(--card);
    }

    .plugin-item .plugin-name {
      font-weight: bold;
      font-size: 14px;
    }

    .plugin-item .plugin-desc {
      font-size: 12px;
      color: var(--muted);
    }

    .plugin-item .plugin-status {
      font-size: 12px;
      font-family: var(--mono);
      padding: 2px 8px;
      border: 1px solid var(--border);
    }

    .plugin-item .plugin-status.enabled {
      color: var(--ok);
      border-color: var(--ok);
    }

    /* Logs */
    .logs-container {
      font-family: var(--mono);
      font-size: 12px;
      max-height: 500px;
      overflow-y: auto;
      border: 1px solid var(--border);
      padding: 8px;
      background: var(--card);
    }

    .log-entry {
      padding: 2px 0;
      border-bottom: 1px solid var(--bg-muted);
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--muted);
      font-style: italic;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.initializeApp();
    window.addEventListener("popstate", this.handlePopState);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("popstate", this.handlePopState);
    client.disconnectWs();
  }

  private handlePopState = (): void => {
    const tab = tabFromPath(window.location.pathname);
    if (tab) this.tab = tab;
  };

  private async initializeApp(): Promise<void> {
    // Check onboarding status
    try {
      const { complete } = await client.getOnboardingStatus();
      this.onboardingComplete = complete;
      if (!complete) {
        const options = await client.getOnboardingOptions();
        this.onboardingOptions = options;
      }
    } catch {
      // API not available yet
    }
    this.onboardingLoading = false;

    // Connect WebSocket
    client.connectWs();
    client.onWsEvent("status", (data) => {
      this.agentStatus = data as unknown as AgentStatus;
    });
    client.onWsEvent("chat:response", (data) => {
      this.chatMessages = [
        ...this.chatMessages,
        { role: "assistant", text: data.text as string, timestamp: Date.now() },
      ];
      this.chatSending = false;
    });
    client.onWsEvent("chat:error", () => {
      this.chatSending = false;
    });

    // Load initial status
    try {
      this.agentStatus = await client.getStatus();
      this.connected = true;
    } catch {
      this.connected = false;
    }

    // Load autonomy status
    try {
      const { enabled } = await client.getAutonomy();
      this.autonomyEnabled = enabled;
    } catch { /* ignore */ }

    // Load tab from URL
    const tab = tabFromPath(window.location.pathname);
    if (tab) this.tab = tab;
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    const path = pathForTab(tab);
    window.history.pushState(null, "", path);

    // Load data for the tab
    if (tab === "plugins") this.loadPlugins();
    if (tab === "skills") this.loadSkills();
    if (tab === "config") this.loadConfig();
    if (tab === "logs") this.loadLogs();
  }

  private async loadPlugins(): Promise<void> {
    try {
      const { plugins } = await client.getPlugins();
      this.plugins = plugins;
    } catch { /* ignore */ }
  }

  private async loadSkills(): Promise<void> {
    try {
      const { skills } = await client.getSkills();
      this.skills = skills;
    } catch { /* ignore */ }
  }

  private async loadConfig(): Promise<void> {
    try {
      this.configRaw = await client.getConfig();
      this.configText = JSON.stringify(this.configRaw, null, 2);
    } catch { /* ignore */ }
  }

  // --- Agent lifecycle ---

  private async handleStart(): Promise<void> {
    try {
      this.agentStatus = await client.startAgent();
    } catch { /* ignore */ }
  }

  private async handleStop(): Promise<void> {
    try {
      this.agentStatus = await client.stopAgent();
    } catch { /* ignore */ }
  }

  private async handlePauseResume(): Promise<void> {
    if (!this.agentStatus) return;
    try {
      if (this.agentStatus.state === "running") {
        this.agentStatus = await client.pauseAgent();
      } else if (this.agentStatus.state === "paused") {
        this.agentStatus = await client.resumeAgent();
      }
    } catch { /* ignore */ }
  }

  // --- Chat ---

  private handleChatSend(): void {
    const text = this.chatInput.trim();
    if (!text || this.chatSending) return;

    this.chatMessages = [
      ...this.chatMessages,
      { role: "user", text, timestamp: Date.now() },
    ];
    this.chatInput = "";
    this.chatSending = true;
    client.sendChat(text);
  }

  private handleChatKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleChatSend();
    }
  }

  // --- Config ---

  private async handleConfigSave(): Promise<void> {
    try {
      const parsed = JSON.parse(this.configText) as Record<string, unknown>;
      await client.updateConfig(parsed);
    } catch { /* ignore parse errors */ }
  }

  // --- Onboarding ---

  private async handleOnboardingNext(): Promise<void> {
    this.onboardingStep += 1;
  }

  private async handleOnboardingFinish(): Promise<void> {
    if (!this.onboardingOptions) return;

    const style = this.onboardingOptions.styles.find(
      (s) => s.catchphrase === this.onboardingStyle,
    );

    const systemPrompt = [
      `You are ${this.onboardingName}, an autonomous AI agent powered by elizaOS.`,
      style?.style ?? "",
      this.onboardingOptions.sharedStyleRules,
    ].join(" ");

    await client.submitOnboarding({
      name: this.onboardingName,
      bio: style?.bio ?? "An autonomous AI agent.",
      systemPrompt,
      provider: this.onboardingProvider || undefined,
      providerApiKey: this.onboardingApiKey || undefined,
      telegramBotToken: this.onboardingTelegramToken || undefined,
      discordBotToken: this.onboardingDiscordToken || undefined,
    });

    this.onboardingComplete = true;

    // Auto-start agent
    try {
      this.agentStatus = await client.startAgent();
    } catch { /* ignore */ }
  }

  // --- Render ---

  render() {
    if (this.onboardingLoading) {
      return html`<div class="app-shell"><div class="empty-state">Loading...</div></div>`;
    }

    if (!this.onboardingComplete) {
      return this.renderOnboarding();
    }

    return html`
      <div class="app-shell">
        ${this.renderHeader()}
        ${this.renderNav()}
        <main>${this.renderView()}</main>
        <footer>milaidy</footer>
      </div>
    `;
  }

  private renderHeader() {
    const status = this.agentStatus;
    const state = status?.state ?? "not_started";
    const name = status?.agentName ?? "Milaidy";

    return html`
      <header>
        <span class="logo">${name}</span>
        <div class="status-bar">
          <span class="status-pill ${state}">${state}</span>
          ${state === "not_started" || state === "stopped"
            ? html`<button class="lifecycle-btn" @click=${this.handleStart}>Start</button>`
            : html`
                <button class="lifecycle-btn" @click=${this.handlePauseResume}>
                  ${state === "running" ? "Pause" : "Resume"}
                </button>
                <button class="lifecycle-btn" @click=${this.handleStop}>Stop</button>
              `}
          <label class="autonomy-toggle" title="Autonomy Mode" style="display:flex;align-items:center;gap:4px;margin-left:8px;cursor:pointer;font-size:12px;">
            <input
              type="checkbox"
              .checked=${this.autonomyEnabled}
              data-action="autonomy-toggle"
              @change=${(e: Event) => this.handleAutonomyToggle((e.target as HTMLInputElement).checked)}
              style="cursor:pointer;"
            />
            <span>Autonomy</span>
          </label>
        </div>
      </header>
    `;
  }

  private async handleAutonomyToggle(enabled: boolean): Promise<void> {
    try {
      await client.setAutonomy(enabled);
      this.autonomyEnabled = enabled;
    } catch (err) {
      console.error("Failed to toggle autonomy:", err);
    }
  }

  private renderNav() {
    return html`
      <nav>
        ${TAB_GROUPS.map(
          (group) => html`
            ${group.tabs.map(
              (t) => html`
                <a
                  href=${pathForTab(t)}
                  class=${this.tab === t ? "active" : ""}
                  @click=${(e: Event) => {
                    e.preventDefault();
                    this.setTab(t);
                  }}
                >${titleForTab(t)}</a>
              `,
            )}
          `,
        )}
      </nav>
    `;
  }

  private renderView() {
    switch (this.tab) {
      case "chat": return this.renderChat();
      case "plugins": return this.renderPlugins();
      case "skills": return this.renderSkills();
      case "config": return this.renderConfig();
      case "logs": return this.renderLogs();
      default: return this.renderChat();
    }
  }

  private renderChat() {
    const state = this.agentStatus?.state ?? "not_started";

    if (state === "not_started" || state === "stopped") {
      return html`
        <h2>Chat</h2>
        <div class="start-agent-box">
          <p>Agent is not running. Start it to begin chatting.</p>
          <button class="btn" @click=${this.handleStart}>Start Agent</button>
        </div>
      `;
    }

    return html`
      <div class="chat-container">
        <div class="chat-messages">
          ${this.chatMessages.length === 0
            ? html`<div class="empty-state">Send a message to start chatting.</div>`
            : this.chatMessages.map(
                (msg) => html`
                  <div class="chat-msg ${msg.role}">
                    <div class="role">${msg.role === "user" ? "You" : this.agentStatus?.agentName ?? "Agent"}</div>
                    <div>${msg.text}</div>
                  </div>
                `,
              )}
        </div>
        <div class="chat-input-row">
          <input
            class="chat-input"
            type="text"
            placeholder="Type a message..."
            .value=${this.chatInput}
            @input=${(e: Event) => { this.chatInput = (e.target as HTMLInputElement).value; }}
            @keydown=${this.handleChatKeydown}
            ?disabled=${this.chatSending}
          />
          <button class="btn" @click=${this.handleChatSend} ?disabled=${this.chatSending}>
            ${this.chatSending ? "..." : "Send"}
          </button>
        </div>
      </div>
    `;
  }

  private renderPlugins() {
    const categories = ["all", "provider", "channel", "feature", "core"] as const;
    const filtered = this.pluginFilter === "all"
      ? this.plugins
      : this.plugins.filter((p) => p.category === this.pluginFilter);

    return html`
      <h2>Plugins</h2>
      <p class="subtitle">Manage plugins and integrations. ${this.plugins.length} plugins discovered.</p>
      <div class="plugin-filters" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
        ${categories.map(
          (cat) => html`
            <button
              class="filter-btn ${this.pluginFilter === cat ? "active" : ""}"
              data-category=${cat}
              @click=${() => { this.pluginFilter = cat; }}
              style="
                padding: 4px 12px;
                border-radius: 12px;
                border: 1px solid var(--border);
                background: ${this.pluginFilter === cat ? "var(--accent)" : "var(--surface)"};
                color: ${this.pluginFilter === cat ? "#fff" : "var(--text)"};
                cursor: pointer;
                font-size: 12px;
              "
            >${cat === "all" ? `All (${this.plugins.length})` : `${cat.charAt(0).toUpperCase() + cat.slice(1)} (${this.plugins.filter((p) => p.category === cat).length})`}</button>
          `,
        )}
      </div>
      ${filtered.length === 0
        ? html`<div class="empty-state">No plugins in this category.</div>`
        : html`
            <div class="plugin-list">
              ${filtered.map(
                (p) => html`
                  <div class="plugin-item" data-plugin-id=${p.id}>
                    <div style="flex:1;min-width:0;">
                      <div style="display:flex;align-items:center;gap:8px;">
                        <div class="plugin-name">${p.name}</div>
                        <span style="font-size:10px;padding:2px 6px;border-radius:8px;background:var(--surface);border:1px solid var(--border);color:var(--muted);">${p.category}</span>
                      </div>
                      <div class="plugin-desc">${p.description || "No description"}</div>
                      ${p.envKey ? html`<div style="font-size:11px;color:var(--muted);margin-top:2px;">Requires: <code style="font-size:11px;">${p.envKey}</code> ${p.configured ? html`<span style="color:var(--ok);">&#10003;</span>` : html`<span style="color:var(--warn);">not set</span>`}</div>` : ""}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                      <label class="toggle-switch" style="position:relative;display:inline-block;width:40px;height:22px;">
                        <input
                          type="checkbox"
                          .checked=${p.enabled}
                          data-plugin-toggle=${p.id}
                          @change=${(e: Event) => this.handlePluginToggle(p.id, (e.target as HTMLInputElement).checked)}
                          style="opacity:0;width:0;height:0;"
                        />
                        <span class="toggle-slider" style="
                          position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
                          background:${p.enabled ? "var(--accent)" : "var(--border)"};
                          border-radius:22px;transition:0.2s;
                        ">
                          <span style="
                            position:absolute;content:'';height:16px;width:16px;left:${p.enabled ? "20px" : "3px"};
                            bottom:3px;background:#fff;border-radius:50%;transition:0.2s;
                          "></span>
                        </span>
                      </label>
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
    `;
  }

  private async handlePluginToggle(pluginId: string, enabled: boolean): Promise<void> {
    try {
      await client.updatePlugin(pluginId, { enabled });
      const plugin = this.plugins.find((p) => p.id === pluginId);
      if (plugin) {
        plugin.enabled = enabled;
        this.requestUpdate();
      }
    } catch (err) {
      console.error("Failed to toggle plugin:", err);
    }
  }

  private renderSkills() {
    return html`
      <h2>Skills</h2>
      <p class="subtitle">View available agent skills. ${this.skills.length > 0 ? `${this.skills.length} skills loaded.` : ""}</p>
      ${this.skills.length === 0
        ? html`<div class="empty-state">No skills loaded yet.</div>`
        : html`
            <div class="plugin-list">
              ${this.skills.map(
                (s) => html`
                  <div class="plugin-item" data-skill-id=${s.id}>
                    <div style="flex:1;min-width:0;">
                      <div class="plugin-name">${s.name}</div>
                      <div class="plugin-desc">${s.description || "No description"}</div>
                    </div>
                    <span class="plugin-status ${s.enabled ? "enabled" : ""}">${s.enabled ? "active" : "inactive"}</span>
                  </div>
                `,
              )}
            </div>
          `}
    `;
  }

  private renderConfig() {
    return html`
      <h2>Config</h2>
      <p class="subtitle">Edit ~/.milaidy/milaidy.json</p>
      <textarea
        class="config-editor"
        .value=${this.configText}
        @input=${(e: Event) => { this.configText = (e.target as HTMLTextAreaElement).value; }}
      ></textarea>
      <div class="btn-row" style="justify-content: flex-end;">
        <button class="btn" @click=${this.handleConfigSave}>Save</button>
      </div>
    `;
  }

  private renderLogs() {
    return html`
      <h2>Logs</h2>
      <p class="subtitle">Agent log output. ${this.logs.length > 0 ? `${this.logs.length} entries.` : ""}</p>
      <div style="margin-bottom:8px;">
        <button class="btn" data-action="refresh-logs" @click=${this.loadLogs} style="font-size:12px;padding:4px 12px;">Refresh</button>
      </div>
      <div class="logs-container">
        ${this.logs.length === 0
          ? html`<div class="empty-state">No log entries yet.</div>`
          : html`
              ${this.logs.map(
                (entry) => html`
                  <div class="log-entry" style="
                    font-family: var(--font-mono, monospace);
                    font-size: 12px;
                    padding: 4px 8px;
                    border-bottom: 1px solid var(--border);
                    display: flex;
                    gap: 8px;
                  ">
                    <span style="color:var(--muted);white-space:nowrap;">${new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span style="
                      font-weight:600;
                      width:48px;
                      text-transform:uppercase;
                      color: ${entry.level === "error" ? "var(--danger, #e74c3c)" : entry.level === "warn" ? "var(--warn, #f39c12)" : "var(--muted)"};
                    ">${entry.level}</span>
                    <span style="color:var(--muted);width:60px;overflow:hidden;text-overflow:ellipsis;">[${entry.source}]</span>
                    <span style="flex:1;word-break:break-all;">${entry.message}</span>
                  </div>
                `,
              )}
            `}
      </div>
    `;
  }

  private async loadLogs(): Promise<void> {
    try {
      const data = await client.getLogs();
      this.logs = data.entries;
    } catch {
      // silent
    }
  }

  // --- Onboarding ---

  private renderOnboarding() {
    const opts = this.onboardingOptions;
    if (!opts) {
      return html`<div class="app-shell"><div class="empty-state">Loading onboarding...</div></div>`;
    }

    return html`
      <div class="app-shell">
        <div class="onboarding">
          ${this.onboardingStep === 0 ? this.renderOnboardingWelcome() : ""}
          ${this.onboardingStep === 1 ? this.renderOnboardingName(opts) : ""}
          ${this.onboardingStep === 2 ? this.renderOnboardingStyle(opts) : ""}
          ${this.onboardingStep === 3 ? this.renderOnboardingProvider(opts) : ""}
          ${this.onboardingStep === 4 ? this.renderOnboardingChannels() : ""}
        </div>
      </div>
    `;
  }

  private renderOnboardingWelcome() {
    return html`
      <h1>Welcome to Milaidy</h1>
      <p>Let's set up your agent in a few quick steps.</p>
      <button class="btn" @click=${this.handleOnboardingNext}>Get Started</button>
    `;
  }

  private renderOnboardingName(opts: OnboardingOptions) {
    return html`
      <h1>Name your agent</h1>
      <p>Pick a name or type your own.</p>
      <div class="onboarding-options">
        ${opts.names.map(
          (name) => html`
            <div
              class="onboarding-option ${this.onboardingName === name ? "selected" : ""}"
              @click=${() => { this.onboardingName = name; }}
            >
              <div class="label">${name}</div>
            </div>
          `,
        )}
      </div>
      <input
        class="onboarding-input"
        type="text"
        placeholder="Or type a custom name..."
        .value=${this.onboardingName}
        @input=${(e: Event) => { this.onboardingName = (e.target as HTMLInputElement).value; }}
      />
      <button
        class="btn"
        @click=${this.handleOnboardingNext}
        ?disabled=${!this.onboardingName.trim()}
      >Next</button>
    `;
  }

  private renderOnboardingStyle(opts: OnboardingOptions) {
    return html`
      <h1>Choose a vibe</h1>
      <p>How should ${this.onboardingName} communicate?</p>
      <div class="onboarding-options">
        ${opts.styles.map(
          (style) => html`
            <div
              class="onboarding-option ${this.onboardingStyle === style.catchphrase ? "selected" : ""}"
              @click=${() => { this.onboardingStyle = style.catchphrase; }}
            >
              <div class="label">${style.catchphrase}</div>
              <div class="hint">${style.hint}</div>
            </div>
          `,
        )}
      </div>
      <button
        class="btn"
        @click=${this.handleOnboardingNext}
        ?disabled=${!this.onboardingStyle}
      >Next</button>
    `;
  }

  private renderOnboardingProvider(opts: OnboardingOptions) {
    const selected = opts.providers.find((p) => p.id === this.onboardingProvider);
    const needsKey = selected && selected.envKey && selected.id !== "elizacloud" && selected.id !== "ollama";

    return html`
      <h1>Choose your AI provider</h1>
      <p>Select how ${this.onboardingName} will think.</p>
      <div class="onboarding-options">
        ${opts.providers.map(
          (provider) => html`
            <div
              class="onboarding-option ${this.onboardingProvider === provider.id ? "selected" : ""}"
              @click=${() => { this.onboardingProvider = provider.id; this.onboardingApiKey = ""; }}
            >
              <div class="label">${provider.name}</div>
              <div class="hint">${provider.description}</div>
            </div>
          `,
        )}
      </div>
      ${needsKey
        ? html`
            <input
              class="onboarding-input"
              type="password"
              placeholder="API Key"
              .value=${this.onboardingApiKey}
              @input=${(e: Event) => { this.onboardingApiKey = (e.target as HTMLInputElement).value; }}
            />
          `
        : ""}
      <button
        class="btn"
        @click=${this.handleOnboardingNext}
        ?disabled=${!this.onboardingProvider || (needsKey && !this.onboardingApiKey.trim())}
      >Next</button>
    `;
  }

  private renderOnboardingChannels() {
    return html`
      <h1>Connect to messaging</h1>
      <p>Optionally connect Telegram and/or Discord. You can skip this.</p>

      <div style="text-align: left; margin-bottom: 16px;">
        <label style="font-size: 13px; color: var(--muted-strong);">Telegram Bot Token</label>
        <input
          class="onboarding-input"
          type="password"
          placeholder="Paste token from @BotFather"
          .value=${this.onboardingTelegramToken}
          @input=${(e: Event) => { this.onboardingTelegramToken = (e.target as HTMLInputElement).value; }}
        />
      </div>

      <div style="text-align: left; margin-bottom: 16px;">
        <label style="font-size: 13px; color: var(--muted-strong);">Discord Bot Token</label>
        <input
          class="onboarding-input"
          type="password"
          placeholder="Paste token from Discord Developer Portal"
          .value=${this.onboardingDiscordToken}
          @input=${(e: Event) => { this.onboardingDiscordToken = (e.target as HTMLInputElement).value; }}
        />
      </div>

      <div class="btn-row">
        <button class="btn btn-outline" @click=${this.handleOnboardingFinish}>Skip</button>
        <button class="btn" @click=${this.handleOnboardingFinish}>Finish</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "milaidy-app": MilaidyApp;
  }
}
