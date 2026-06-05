// odysseus Admin panel (static/js/admin.js + the admin sub-tabs of the settings
// modal in static/index.html). The admin-only surface, presented as ONE vertical
// column: a horizontal tab bar of admin sections (Agent Tools / Users / System)
// above a single content panel that renders one section at a time — the Users tab
// (Registration
// "Open signup" toggle, the user list with a per-user privilege panel — feature
// toggles, a daily-message limit, and an allowed-models checkbox list — plus an
// Add User form), the System tab (Data Backup export/import + a per-category
// Danger Zone wipe list), and the Agent Tools tab (the single "Built-in Tools"
// card whose body is a categorized, collapsible tool catalogue — admin.js
// loadBuiltinTools() rendering #adm-builtin-tools-list, index.html ~line 2121).
// 1:1 chrome: .admin-card / .admin-switch / .admin-user-row / .admin-badge /
// .admin-btn-* / .admin-tool-* mirror odysseus's DOM and CSS classes.
//
// elizaMapping: odysseus's admin panel is backed by a multi-user auth server
// (GET/POST /api/auth/users, /api/auth/status, /api/auth/signup-toggle,
// /api/auth/features, /api/auth/users/{u}/privileges, /api/admin/wipe/{kind},
// /api/export, /api/import). The eliza orchestrator client exposes NONE of these
// (grepped the @elizaos/ui `client` singleton — there is no listUsers /
// signupEnabled / authFeatures / adminWipe method; tsgo would fail on any
// invented call). eliza runs a single agent, not a multi-tenant auth surface,
// so this is the faithful no-eliza-equivalent path: the FULL admin chrome is
// built pixel-exact so it lights up the moment such a backend exists, but every
// surface renders its honest EMPTY/DISABLED state — the user list shows
// odysseus's "No users found", toggles are disabled, and a panel-wide notice
// reads "Admin features require server configuration." NO fabricated users,
// roles, or feature flags are ever shown. The one real mapping is the allowed-
// models checkbox list, populated from client.fetchModels(provider) — the same
// /api/models fetch CompareView + GalleryView use — so it lights up with the
// agent's real providers even though no users exist to assign them to.

import type { ProviderModelRecord } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  ChevronDown,
  Database,
  Download,
  Minus,
  Settings as SettingsIcon,
  ShieldAlert,
  Upload,
  UserPlus,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

// Providers whose model lists feed the per-user "Allowed models" checkbox list —
// the same real /api/models fetch keys CompareView + GalleryView use.
const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

type AdminTab = "users" | "system" | "tools";

// odysseus admin.js PRIV_LABELS — the per-user boolean feature grants. Kept 1:1
// so the privilege panel reads exactly like odysseus's once a user backend
// exists to bind them to.
const PRIV_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["can_use_agent", "Agent mode"],
  ["can_use_browser", "Browser automation"],
  ["can_use_bash", "Shell / Python / Files"],
  ["can_use_documents", "Document editor"],
  ["can_use_research", "Deep research"],
  ["can_generate_images", "Image generation"],
  ["can_manage_memory", "Memory & skills"],
];

// odysseus admin.js TOOL_META — the built-in tool catalogue rendered into the
// Agent Tools tab's single "Built-in Tools" card (loadBuiltinTools(), grouped
// by `cat` in CATEGORY_ORDER). Each row is name + description + an approximate
// context-token badge. This is static catalogue metadata describing odysseus's
// tool surface — NOT fabricated runtime state — so the card reads exactly like
// odysseus's while every toggle stays disabled until a /api/tools backend
// exists to report and persist enabled/disabled state. (admin.js's dead
// featureLabels/loadFeatures targeted #adm-featureToggles, which exists nowhere
// in index.html, so it is intentionally omitted.)
interface ToolMeta {
  id: string;
  name: string;
  desc: string;
  cat: string;
  ctx: string;
}

const TOOL_META: readonly ToolMeta[] = [
  {
    id: "bash",
    name: "Shell",
    desc: "Execute bash commands",
    cat: "Code",
    ctx: "~200",
  },
  {
    id: "python",
    name: "Python",
    desc: "Run Python scripts",
    cat: "Code",
    ctx: "~200",
  },
  {
    id: "read_file",
    name: "Read File",
    desc: "Read files from disk",
    cat: "Code",
    ctx: "~150",
  },
  {
    id: "write_file",
    name: "Write File",
    desc: "Write/create files",
    cat: "Code",
    ctx: "~150",
  },
  {
    id: "web_search",
    name: "Web Search",
    desc: "Search the web via SearXNG",
    cat: "Search",
    ctx: "~300",
  },
  {
    id: "search_chats",
    name: "Search Chats",
    desc: "Search conversation history",
    cat: "Search",
    ctx: "~150",
  },
  {
    id: "create_document",
    name: "Create Document",
    desc: "Create new documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "update_document",
    name: "Update Document",
    desc: "Modify existing documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "edit_document",
    name: "Edit Document",
    desc: "Find & replace in documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "suggest_document",
    name: "Suggest Changes",
    desc: "Propose document edits",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "manage_documents",
    name: "Manage Documents",
    desc: "List, delete, organize docs",
    cat: "Documents",
    ctx: "~150",
  },
  {
    id: "generate_image",
    name: "Generate Image",
    desc: "Create images via AI",
    cat: "Media",
    ctx: "~150",
  },
  {
    id: "manage_memory",
    name: "Memory",
    desc: "Save and recall memories",
    cat: "Knowledge",
    ctx: "~200",
  },
  {
    id: "manage_skills",
    name: "Skills",
    desc: "Learn and use procedures",
    cat: "Knowledge",
    ctx: "~200",
  },
  {
    id: "manage_rag",
    name: "RAG / Docs",
    desc: "Query indexed documents",
    cat: "Knowledge",
    ctx: "~150",
  },
  {
    id: "chat_with_model",
    name: "Chat with Model",
    desc: "Talk to another AI model",
    cat: "Multi-Agent",
    ctx: "~200",
  },
  {
    id: "second_opinion",
    name: "Second Opinion",
    desc: "Get another model's take",
    cat: "Multi-Agent",
    ctx: "~150",
  },
  {
    id: "pipeline",
    name: "Pipeline",
    desc: "Multi-step AI workflows",
    cat: "Multi-Agent",
    ctx: "~200",
  },
  {
    id: "ask_teacher",
    name: "Ask Teacher",
    desc: "Query a more capable model",
    cat: "Multi-Agent",
    ctx: "~150",
  },
  {
    id: "send_to_session",
    name: "Send to Session",
    desc: "Send message to another chat",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "create_session",
    name: "Create Session",
    desc: "Start a new chat session",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "list_sessions",
    name: "List Sessions",
    desc: "Browse existing sessions",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "manage_session",
    name: "Manage Session",
    desc: "Rename, archive, configure",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "list_models",
    name: "List Models",
    desc: "Show available models",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "ui_control",
    name: "UI Control",
    desc: "Change theme, layout, settings",
    cat: "System",
    ctx: "~150",
  },
  {
    id: "manage_tasks",
    name: "Tasks",
    desc: "Schedule automated tasks",
    cat: "System",
    ctx: "~150",
  },
  {
    id: "api_call",
    name: "API Call",
    desc: "Make HTTP requests",
    cat: "System",
    ctx: "~200",
  },
  {
    id: "manage_endpoints",
    name: "Endpoints",
    desc: "Add/remove model endpoints",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_mcp",
    name: "MCP Servers",
    desc: "Manage MCP connections",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_webhooks",
    name: "Webhooks",
    desc: "Configure webhook events",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_tokens",
    name: "API Tokens",
    desc: "Manage API access tokens",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_settings",
    name: "Settings",
    desc: "Change app settings",
    cat: "System",
    ctx: "~100",
  },
];

// admin.js loadBuiltinTools() catOrder — the category render order. "Other" is
// odysseus's catch-all for tools without TOOL_META; no catalogue rows fall into
// it here, so it renders only if the list ever gains an unknown tool.
const CATEGORY_ORDER = [
  "Code",
  "Search",
  "Documents",
  "Media",
  "Knowledge",
  "Multi-Agent",
  "Sessions",
  "System",
  "Other",
] as const;

// odysseus index.html Danger Zone rows (data-wipe-kind + label + sub). 1:1.
interface WipeRow {
  kind: string;
  label: string;
  sub: string;
}

const WIPE_ROWS: WipeRow[] = [
  {
    kind: "chats",
    label: "Wipe all chats",
    sub: "Every session, message, and chat history. Documents/notes/etc. stay.",
  },
  {
    kind: "memory",
    label: "Wipe all memory",
    sub: "Clears the Memory table and the vector store. Skills not affected.",
  },
  {
    kind: "skills",
    label: "Wipe all skills",
    sub: "Drops every SKILL.md file. Memory not affected.",
  },
  {
    kind: "notes",
    label: "Wipe all notes",
    sub: "Every note, todo, and checklist.",
  },
  {
    kind: "tasks",
    label: "Wipe all tasks",
    sub: "Every scheduled task and its run history.",
  },
  {
    kind: "documents",
    label: "Wipe all documents",
    sub: "Every document and version. Drafts, exports, library — all gone.",
  },
  {
    kind: "gallery",
    label: "Wipe all gallery",
    sub: "Every image record and the upload directory on disk.",
  },
  {
    kind: "calendar",
    label: "Wipe all calendar",
    sub: "Every event and every calendar (incl. CalDAV-synced ones).",
  },
];

// A user record, shaped to odysseus admin.js's /api/auth/users rows so the list
// + privilege panel light up 1:1 the moment an auth backend populates it. The
// default set is always empty (honest empty state) — never seeded with demo
// rows.
interface AdminUser {
  username: string;
  is_admin: boolean;
}

export function AdminView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls(
    "win-admin",
    { w: 900, h: 760 },
    { label: "Admin", icon: "ShieldAlert", onClose },
  );
  const [tab, setTab] = useState<AdminTab>("users");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModelRecord[]>([]);

  // No eliza client method backs a multi-user auth surface (see file header) —
  // the user set is intentionally empty until such a backend exists. Never
  // seeded with demo data.
  const users = useMemo<AdminUser[]>(() => [], []);

  // Populate the "Allowed models" checkbox list from the REAL provider model
  // lists — the same /api/models endpoint the settings + compare surfaces use.
  // Failures are non-fatal: the list simply shows fewer models.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all(
      PROVIDERS.map((provider) =>
        client
          .fetchModels(provider)
          .then((r): ProviderModelRecord[] => r.models)
          .catch((): ProviderModelRecord[] => []),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const flat: ProviderModelRecord[] = [];
      for (const m of lists.flat()) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        flat.push(m);
      }
      flat.sort((a, b) => a.name.localeCompare(b.name));
      setModels(flat);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;
  if (win.minimized) return null;

  return (
    <div
      className={`od-search-overlay od-admin-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Admin"
    >
      <button
        type="button"
        aria-label="Close admin"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-admin-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Modal header (settings-modal header) ── */}
        <div
          className="od-admin-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-admin-header-title">
            <ShieldAlert size={14} aria-hidden="true" />
            Admin
          </span>
          <span className="od-admin-header-spacer" />
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-admin-close"
            aria-label="Close admin"
            title="Close"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {/* ── Honest empty-state notice: eliza has no admin/auth backend ── */}
        <div className="od-admin-notice">
          Admin features require server configuration. This orchestrator runs a
          single agent — multi-user management, signup control, and feature
          flags light up once an auth backend is connected.
        </div>

        <div className="od-admin-body">
          {/* ── Horizontal section tab bar above the panel (single-pane). The
              modal header already reads "Admin", so no standalone rail label. ── */}
          <div
            className="od-admin-rail"
            role="tablist"
            aria-label="Admin sections"
          >
            {/* Tab order matches the real odysseus settings ADMIN group:
                Agent Tools, then Users, then System (verified vs 16-admin.png). */}
            <button
              type="button"
              role="tab"
              aria-selected={tab === "tools"}
              className={`od-admin-rail-item${tab === "tools" ? " active" : ""}`}
              onClick={() => setTab("tools")}
            >
              <Wrench size={15} aria-hidden="true" />
              <span>Agent Tools</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "users"}
              className={`od-admin-rail-item${tab === "users" ? " active" : ""}`}
              onClick={() => setTab("users")}
            >
              <Users size={15} aria-hidden="true" />
              <span>Users</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "system"}
              className={`od-admin-rail-item${tab === "system" ? " active" : ""}`}
              onClick={() => setTab("system")}
            >
              <SettingsIcon size={15} aria-hidden="true" />
              <span>System</span>
            </button>
          </div>

          {/* ── Single content panel below the tab bar (one section at a time) ── */}
          <div className="od-admin-panels">
            {tab === "users" ? (
              <UsersTab
                users={users}
                models={models}
                expandedUser={expandedUser}
                onToggleUser={(u) =>
                  setExpandedUser((cur) => (cur === u ? null : u))
                }
              />
            ) : null}
            {tab === "tools" ? <ToolsTab /> : null}
            {tab === "system" ? <SystemTab /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function UsersTab({
  users,
  models,
  expandedUser,
  onToggleUser,
}: {
  users: AdminUser[];
  models: ProviderModelRecord[];
  expandedUser: string | null;
  onToggleUser: (username: string) => void;
}): ReactNode {
  return (
    <>
      {/* ── Registration card (index.html ADMIN: USERS — Registration) ── */}
      <div className="od-admin-card">
        <h2 className="od-admin-card-title">
          <UserPlus size={14} aria-hidden="true" />
          Registration
        </h2>
        <div className="od-admin-toggle-row">
          <div>
            <div className="od-admin-toggle-label">Open signup</div>
            <div className="od-admin-toggle-sub">
              Allow anyone to create an account from the login page
            </div>
          </div>
          <label className="od-admin-switch" title="Requires an auth backend">
            <input type="checkbox" disabled />
            <span className="od-admin-slider" />
          </label>
        </div>
      </div>

      {/* ── Users list card (index.html ADMIN: USERS — Users) ── */}
      <div className="od-admin-card">
        <h2 className="od-admin-card-title">
          <Users size={14} aria-hidden="true" />
          Users
        </h2>
        {users.length === 0 ? (
          <div className="od-admin-empty">No users found</div>
        ) : (
          users.map((u) => (
            <UserRow
              key={u.username}
              user={u}
              models={models}
              expanded={expandedUser === u.username}
              onToggle={() => onToggleUser(u.username)}
            />
          ))
        )}
      </div>

      {/* ── Add User form (index.html ADMIN: USERS — Add User) ── */}
      <div className="od-admin-card">
        <h2 className="od-admin-card-title">
          <UserPlus size={14} aria-hidden="true" />
          Add User
        </h2>
        <div className="od-admin-add-form">
          <input type="text" placeholder="Username (email)" disabled />
          <input type="password" placeholder="Password (min 8)" disabled />
          <div
            className="od-admin-switch-inline"
            title="Grant full admin access"
          >
            <label className="od-admin-switch">
              <input type="checkbox" disabled />
              <span className="od-admin-slider" />
            </label>{" "}
            Admin
          </div>
        </div>
        <div className="od-admin-add-row">
          <button type="button" className="od-admin-btn-add" disabled>
            Add User
          </button>
          <span className="od-admin-add-msg">Auth backend not connected</span>
        </div>
      </div>
    </>
  );
}

function UserRow({
  user,
  models,
  expanded,
  onToggle,
}: {
  user: AdminUser;
  models: ProviderModelRecord[];
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const initial = user.username.charAt(0).toUpperCase();
  return (
    <div className="od-admin-user-row">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: mirrors odysseus's click-to-expand user header; the Rename/Remove buttons within it are real buttons. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — odysseus header row is click-to-expand. */}
      <div
        className="od-admin-user-header"
        onClick={() => {
          if (!user.is_admin) onToggle();
        }}
      >
        <div className="od-admin-user-info">
          <span className="od-admin-user-avatar">{initial}</span>
          <div>
            <span className="od-admin-user-name">{user.username}</span>
            {user.is_admin ? (
              <span className="od-admin-badge">ADMIN</span>
            ) : (
              <span className="od-admin-user-hint">
                Click to manage privileges
              </span>
            )}
          </div>
        </div>
        <div className="od-admin-user-actions">
          <button type="button" className="od-admin-btn-sm" disabled>
            Rename
          </button>
          {user.is_admin ? null : (
            <button type="button" className="od-admin-btn-delete" disabled>
              Remove
            </button>
          )}
          {/* odysseus shows a rotating expand chevron on non-admin rows
              (admin.js line 59: .admin-user-chevron), rotating 180deg when the
              privilege panel opens. Admin rows have no privilege panel, so no
              chevron — matching odysseus. */}
          {user.is_admin ? null : (
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={`od-admin-user-chevron${expanded ? " open" : ""}`}
            />
          )}
        </div>
      </div>

      {user.is_admin ? null : (
        <div className={`od-admin-priv-panel${expanded ? "" : " hidden"}`}>
          <div className="od-admin-priv-section">Features</div>
          {PRIV_LABELS.map(([key, label]) => (
            <div className="od-admin-priv-row" key={key}>
              <span className="od-admin-priv-label">{label}</span>
              <label className="od-admin-switch od-admin-switch-sm">
                <input type="checkbox" disabled />
                <span className="od-admin-slider" />
              </label>
            </div>
          ))}

          <div className="od-admin-priv-section">Limits</div>
          <div className="od-admin-priv-row">
            <div>
              <span className="od-admin-priv-label">Daily message limit</span>
              <div className="od-admin-priv-hint">0 = no limit</div>
            </div>
            <input
              type="number"
              min={0}
              defaultValue={0}
              disabled
              className="od-admin-priv-num"
            />
          </div>

          <div className="od-admin-priv-models-head">
            <span className="od-admin-priv-label">Allowed models</span>
            <span className="od-admin-priv-models-actions">
              <span>All</span>
              <span>None</span>
            </span>
          </div>
          <div className="od-admin-priv-hint">
            All models allowed (no restrictions)
          </div>
          <div className="od-admin-priv-models-list">
            {models.length === 0 ? (
              <span className="od-admin-priv-models-empty">
                No models available
              </span>
            ) : (
              models.map((m) => (
                <label className="od-admin-priv-model-row" key={m.id}>
                  <input type="checkbox" disabled defaultChecked />
                  <span>{m.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// odysseus Agent Tools tab — the single "Built-in Tools" card whose body is the
// categorized, collapsible catalogue (admin.js loadBuiltinTools, index.html
// #adm-builtin-tools-list). No eliza client method backs /api/tools (no
// listTools/builtinTools on the @elizaos/ui client — see file header), so the
// catalogue renders the real odysseus tool surface with every toggle disabled:
// the chrome (category groups, count badges, collapsible bodies, per-tool rows
// with a context-token badge) is pixel-exact and lights up the moment such a
// backend exists, but no enabled/disabled runtime state is fabricated.
function ToolsTab(): ReactNode {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    // odysseus renders every category body with the `hidden` class — collapsed
    // by default. Start every catalogue category collapsed to match.
    () => new Set(CATEGORY_ORDER),
  );

  const categories = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        cat,
        tools: TOOL_META.filter((t) => t.cat === cat),
      })).filter((g) => g.tools.length > 0),
    [],
  );

  const toggleCategory = (cat: string): void => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="od-admin-card">
      <h2 className="od-admin-card-title">
        <Wrench size={14} aria-hidden="true" />
        Built-in Tools
      </h2>
      <div className="od-admin-toggle-sub">
        Enable or disable tools available to the AI agent.
      </div>
      <div className="od-admin-tool-list">
        {categories.length === 0 ? (
          <div className="od-admin-empty">No tools found</div>
        ) : (
          categories.map(({ cat, tools }) => {
            const isOpen = !collapsed.has(cat);
            return (
              <div className="od-admin-tool-category" key={cat}>
                <button
                  type="button"
                  className="od-admin-tool-cat-header"
                  aria-expanded={isOpen}
                  onClick={() => toggleCategory(cat)}
                >
                  <span>{cat}</span>
                  <span className="od-admin-tool-cat-right">
                    {/* odysseus shows enabledCount/totalCount (admin.js
                        loadBuiltinTools). No /api/tools backend reports an
                        enabled set, so every toggle renders unchecked — the
                        honest count is therefore 0/total, matching the off
                        switches (NOT total/total, which would imply all on). */}
                    <span className="od-admin-tool-cat-count">
                      0/{tools.length}
                    </span>
                    <span
                      className="od-admin-switch"
                      title="Requires a tools backend"
                    >
                      <input type="checkbox" disabled />
                      <span className="od-admin-slider" />
                    </span>
                    <ChevronDown
                      size={12}
                      aria-hidden="true"
                      className={`od-admin-tool-cat-chevron${isOpen ? " open" : ""}`}
                    />
                  </span>
                </button>
                {isOpen ? (
                  <div className="od-admin-tool-cat-body">
                    {tools.map((t) => (
                      <div className="od-admin-tool-row" key={t.id}>
                        <div className="od-admin-tool-info">
                          <span className="od-admin-tool-name">{t.name}</span>
                          <span className="od-admin-tool-desc">{t.desc}</span>
                        </div>
                        <span
                          className="od-admin-tool-ctx"
                          title="Approximate context tokens used"
                        >
                          {t.ctx}
                        </span>
                        <label className="od-admin-switch">
                          <input type="checkbox" disabled />
                          <span className="od-admin-slider" />
                        </label>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SystemTab(): ReactNode {
  return (
    <>
      {/* ── Data Backup card (index.html SYSTEM — Data Backup) ── */}
      <div className="od-admin-card">
        <h2 className="od-admin-card-title">
          <Database size={14} aria-hidden="true" />
          Data Backup
        </h2>
        <div className="od-admin-toggle-sub">
          Export or import your user data (memories, presets, settings, skills,
          preferences) as a JSON file.
        </div>
        <div className="od-admin-backup-row">
          <button type="button" className="od-admin-btn-add" disabled>
            <Download size={12} aria-hidden="true" />
            Export Data
          </button>
          <button type="button" className="od-admin-btn-add" disabled>
            <Upload size={12} aria-hidden="true" />
            Import Data
          </button>
        </div>
        <div className="od-admin-add-msg">Backup endpoints not connected</div>
      </div>

      {/* ── Danger Zone card (index.html SYSTEM — Danger Zone) ── */}
      <div className="od-admin-card od-admin-danger-card">
        {/* odysseus's Danger Zone heading is a plain colored <h2> with no
            icon (index.html line 2143: <h2 style="color:#e55">Danger Zone). */}
        <h2 className="od-admin-card-title od-admin-danger-title">
          Danger Zone
        </h2>
        <div className="od-admin-toggle-sub">
          Irreversible. Each wipe targets one category — pick exactly what you
          want gone.
        </div>
        {WIPE_ROWS.map((row) => (
          <div className="od-admin-wipe-row" key={row.kind}>
            <div>
              <div className="od-admin-toggle-label">{row.label}</div>
              <div className="od-admin-toggle-sub">{row.sub}</div>
            </div>
            <button type="button" className="od-admin-btn-delete" disabled>
              Wipe
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
