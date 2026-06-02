// odysseus Admin panel (static/js/admin.js + the admin sub-tabs of the settings
// modal in static/index.html). The admin-only surface: a left rail of admin
// sections (Users / System / Agent Tools), the Users tab (Registration
// "Open signup" toggle, the user list with a per-user privilege panel — feature
// toggles, a daily-message limit, and an allowed-models checkbox list — plus an
// Add User form), the System tab (Data Backup export/import + a per-category
// Danger Zone wipe list), and the Agent Tools tab (feature toggles + built-in
// tool catalogue). 1:1 chrome: .admin-card / .admin-switch / .admin-user-row /
// .admin-badge / .admin-btn-* mirror odysseus's DOM and CSS classes.
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
  Database,
  Download,
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

// odysseus admin.js featureLabels — the instance-wide feature toggles (Agent
// Tools tab). 1:1 from the source map.
const FEATURE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["web_search", "Web Search"],
  ["deep_research", "Deep Research"],
  ["memory", "Memory"],
  ["document_editor", "Document Editor"],
  ["rag", "RAG Knowledge Base"],
  ["sensitive_filter", "Sensitive Info Filter"],
  ["gallery", "Gallery"],
];

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
  const win = useWindowControls("win-admin", { w: 900, h: 760 });
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

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
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
          {/* ── Left rail of admin sections (settings-sidebar admin-only) ── */}
          <div
            className="od-admin-rail"
            role="tablist"
            aria-label="Admin sections"
          >
            <div className="od-admin-rail-label">Admin</div>
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
              aria-selected={tab === "system"}
              className={`od-admin-rail-item${tab === "system" ? " active" : ""}`}
              onClick={() => setTab("system")}
            >
              <SettingsIcon size={15} aria-hidden="true" />
              <span>System</span>
            </button>
          </div>

          {/* ── Panels ── */}
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

function ToolsTab(): ReactNode {
  return (
    <div className="od-admin-card">
      <h2 className="od-admin-card-title">
        <Wrench size={14} aria-hidden="true" />
        Instance Features
      </h2>
      <div className="od-admin-toggle-sub">
        Enable or disable instance-wide features available to agents. Requires
        an auth backend to persist.
      </div>
      <div className="od-admin-feature-list">
        {FEATURE_LABELS.map(([key, label]) => (
          <div className="od-admin-toggle-row od-admin-feature-row" key={key}>
            <div className="od-admin-toggle-label">{label}</div>
            <label className="od-admin-switch">
              <input type="checkbox" disabled />
              <span className="od-admin-slider" />
            </label>
          </div>
        ))}
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
          Export or import your data (memories, presets, settings, skills,
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
        <h2 className="od-admin-card-title od-admin-danger-title">
          <ShieldAlert size={14} aria-hidden="true" />
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
