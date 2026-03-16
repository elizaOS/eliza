/**
 * Skills management view — create, enable/disable, and install skills.
 *
 * Professional card-grid layout with search, stats, polished toggle switches,
 * and a structured install modal. Follows the CSS variable design system used
 * throughout the app (--bg, --card, --border, --accent, --muted, --txt, etc.).
 */

import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
  SkillInfo,
  SkillMarketplaceResult,
  SkillScanReportSummary,
} from "../api";
import { client } from "../api";
import { useTimeout } from "../hooks";
import { useApp } from "../state";
import { ConfirmDeleteControl } from "./confirm-delete-control";
import { StatusBadge } from "./ui-badges";
import { Switch } from "./ui-switch";

/* ── Skill Card ─────────────────────────────────────────────────────── */

function SkillCard({
  skill,
  skillToggleAction,
  skillReviewId,
  skillReviewReport,
  skillReviewLoading,
  onToggle,
  onEdit,
  onDelete,
  onReview,
  onAcknowledge,
  onDismissReview,
}: {
  skill: SkillInfo;
  skillToggleAction: string;
  skillReviewId: string;
  skillReviewReport: ReturnType<typeof useApp>["skillReviewReport"];
  skillReviewLoading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (skill: SkillInfo) => void;
  onDelete: (id: string, name: string) => void;
  onReview: (id: string) => void;
  onAcknowledge: (id: string) => void;
  onDismissReview: () => void;
}) {
  const { t } = useApp();
  const isQuarantined =
    skill.scanStatus === "warning" || skill.scanStatus === "critical";
  const isBlocked = skill.scanStatus === "blocked";
  const isReviewing = skillReviewId === skill.id;

  return (
    <div
      className={`flex flex-col border bg-[var(--card)] transition-colors ${
        isQuarantined || isBlocked
          ? "border-[#e74c3c]/40"
          : "border-[var(--border)] hover:border-[var(--accent)]/50"
      }`}
      data-skill-id={skill.id}
    >
      {/* Main content area */}
      <div className="p-4">
        {/* Top row: badge + toggle */}
        <div className="flex items-center justify-between mb-2.5">
          <StatusBadge
            label={
              skill.scanStatus === "blocked" || skill.scanStatus === "critical"
                ? "Blocked"
                : skill.scanStatus === "warning"
                  ? "Warning"
                  : skill.enabled
                    ? "Active"
                    : "Inactive"
            }
            tone={
              skill.scanStatus === "blocked" ||
              skill.scanStatus === "critical" ||
              skill.scanStatus === "warning"
                ? skill.scanStatus === "warning"
                  ? "warning"
                  : "danger"
                : skill.enabled
                  ? "success"
                  : "muted"
            }
            withDot
          />
          {!isBlocked && !isQuarantined && (
            <Switch
              checked={skill.enabled}
              disabled={skillToggleAction === skill.id}
              onChange={(val) => onToggle(skill.id, val)}
              size="compact"
              trackOnClass="bg-[var(--accent)]"
              trackOffClass="bg-[var(--border)]"
              knobClass="bg-white shadow-sm"
            />
          )}
          {isQuarantined && !isReviewing && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px] font-bold bg-[#f39c12]/15 text-[#f39c12] border-[#f39c12]/30 hover:bg-[#f39c12]/25 hover:text-[#f39c12] transition-colors"
              onClick={() => onReview(skill.id)}
            >
              {t("skillsview.ReviewFindings")}
            </Button>
          )}
        </div>

        {/* Name + description */}
        <div
          className="font-semibold text-sm text-[var(--txt)] mb-1 truncate"
          title={skill.name}
        >
          {skill.name}
        </div>
        <div className="text-[11px] text-[var(--muted)] line-clamp-2 min-h-[2em]">
          {skill.description || "No description provided"}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border/40 bg-black/5 mt-auto">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-[11px] font-bold text-muted hover:text-txt transition-colors"
          onClick={() => onEdit(skill)}
        >
          {t("triggersview.Edit")}
        </Button>
        <ConfirmDeleteControl
          triggerClassName="h-7 px-3 text-[11px] font-bold text-danger hover:bg-danger/10 hover:text-danger-foreground transition-colors rounded-md"
          confirmClassName="px-3 py-1 text-[11px] font-bold bg-danger text-danger-foreground hover:bg-danger/90 transition-colors rounded-md shadow-sm"
          cancelClassName="px-3 py-1 text-[11px] font-bold text-muted border border-border/40 hover:text-txt transition-colors rounded-md"
          confirmLabel="Yes"
          cancelLabel="No"
          onConfirm={() => onDelete(skill.id, skill.name)}
        />
        <span className="flex-1" />
        <span
          className="text-[10px] text-[var(--muted)] font-mono truncate max-w-[120px]"
          title={skill.id}
        >
          {skill.id.length > 16 ? `${skill.id.slice(0, 16)}...` : skill.id}
        </span>
      </div>

      {/* Inline review panel */}
      {isReviewing && skillReviewReport ? (
        <div className="border-t border-[var(--border)] p-4 bg-[var(--bg)]">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-[var(--txt)]">
              {t("skillsview.ScanReport")}
            </span>
            <span className="text-[11px] text-[#e74c3c] font-mono">
              {skillReviewReport.summary.critical} {t("skillsview.critical")}
            </span>
            <span className="text-[11px] text-[#f39c12] font-mono">
              {skillReviewReport.summary.warn} {t("skillsview.warnings")}
            </span>
          </div>
          {skillReviewReport.findings.length > 0 && (
            <div className="max-h-40 overflow-y-auto mb-3 border border-[var(--border)] bg-[var(--card)]">
              {skillReviewReport.findings.map(
                (
                  f: SkillScanReportSummary["findings"][number],
                  idx: number,
                ) => (
                  <div
                    key={`${f.file}:${f.line}:${f.message}`}
                    className={`flex items-start gap-2 px-3 py-1.5 text-[11px] font-mono ${
                      idx > 0 ? "border-t border-[var(--border)]" : ""
                    }`}
                  >
                    <span
                      className={`shrink-0 px-1.5 py-px font-bold text-[10px] uppercase ${
                        f.severity === "critical"
                          ? "bg-[#e74c3c]/15 text-[#e74c3c]"
                          : "bg-[#f39c12]/15 text-[#f39c12]"
                      }`}
                    >
                      {f.severity}
                    </span>
                    <span className="text-[var(--txt)] flex-1 min-w-0">
                      {f.message}
                    </span>
                    <span className="text-[var(--muted)] shrink-0">
                      {f.file}:{f.line}
                    </span>
                  </div>
                ),
              )}
            </div>
          )}
          <div className="flex gap-2.5 mt-2">
            <Button
              variant="default"
              size="sm"
              className="h-7 px-3 text-[11px] font-bold tracking-wide shadow-sm"
              onClick={() => onAcknowledge(skill.id)}
            >
              {t("skillsview.AcknowledgeAmpEn")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-[11px] font-bold text-muted hover:text-txt transition-colors"
              onClick={onDismissReview}
            >
              {t("skillsview.Dismiss")}
            </Button>
          </div>
        </div>
      ) : isReviewing && skillReviewLoading ? (
        <div className="border-t border-[var(--border)] p-4 text-xs text-[var(--muted)] italic">
          {t("skillsview.LoadingScanReport")}
        </div>
      ) : null}
    </div>
  );
}

/* ── Marketplace Result Card ────────────────────────────────────────── */

function MarketplaceCard({
  item,
  isInstalled,
  skillsMarketplaceAction,
  onInstall,
  onUninstall,
}: {
  item: SkillMarketplaceResult;
  isInstalled: boolean;
  skillsMarketplaceAction: string;
  onInstall: (item: SkillMarketplaceResult) => void;
  onUninstall: (skillId: string, name: string) => void;
}) {
  const { t } = useApp();
  const isInstalling = skillsMarketplaceAction === `install:${item.id}`;
  const isUninstalling = skillsMarketplaceAction === `uninstall:${item.id}`;
  const sourceLabel = item.repository || item.slug || item.id;

  return (
    <div className="flex items-start gap-4 p-4 border border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]/50 transition-colors">
      {/* Icon placeholder */}
      <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-[var(--accent)]/10 text-[var(--accent)] text-sm font-bold rounded">
        {item.name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-[var(--txt)]">
          {item.name}
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-0.5 line-clamp-2">
          {item.description || "No description."}
        </div>
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--muted)]">
          <span className="font-mono">{sourceLabel}</span>
          {item.score != null && (
            <>
              <span className="text-[var(--border)]">/</span>
              <span>
                {t("skillsview.score")} {item.score.toFixed(2)}
              </span>
            </>
          )}
          {item.tags && item.tags.length > 0 && (
            <>
              <span className="text-[var(--border)]">/</span>
              {item.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-px bg-[var(--accent)]/10 text-[var(--accent)]"
                >
                  {tag}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
      {isInstalled ? (
        <Button
          variant="destructive"
          size="sm"
          className="h-8 px-4 text-[11px] font-bold tracking-wide shadow-sm shrink-0"
          onClick={() => onUninstall(item.id, item.name)}
          disabled={isUninstalling}
        >
          {isUninstalling ? "Removing..." : "Uninstall"}
        </Button>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="h-8 px-4 text-[11px] font-bold tracking-wide shadow-sm shrink-0"
          onClick={() => onInstall(item)}
          disabled={isInstalling}
        >
          {isInstalling ? "Installing..." : "Install"}
        </Button>
      )}
    </div>
  );
}

/* ── Install Modal ──────────────────────────────────────────────────── */

type InstallTab = "search" | "url";

function InstallModal({
  skills,
  skillsMarketplaceQuery,
  skillsMarketplaceResults,
  skillsMarketplaceError,
  skillsMarketplaceLoading,
  skillsMarketplaceAction,
  skillsMarketplaceManualGithubUrl,
  searchSkillsMarketplace,
  installSkillFromMarketplace,
  uninstallMarketplaceSkill,
  installSkillFromGithubUrl,
  setState,
  onClose,
}: {
  skills: SkillInfo[];
  skillsMarketplaceQuery: string;
  skillsMarketplaceResults: SkillMarketplaceResult[];
  skillsMarketplaceError: string;
  skillsMarketplaceLoading: boolean;
  skillsMarketplaceAction: string;
  skillsMarketplaceManualGithubUrl: string;
  searchSkillsMarketplace: () => Promise<void>;
  installSkillFromMarketplace: (item: SkillMarketplaceResult) => Promise<void>;
  uninstallMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  installSkillFromGithubUrl: () => Promise<void>;
  setState: ReturnType<typeof useApp>["setState"];
  onClose: () => void;
}) {
  const { t } = useApp();
  const [tab, setTab] = useState<InstallTab>("search");

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden mx-4"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          backdropFilter: "blur(20px) saturate(115%)",
          boxShadow: "var(--shadow-lg)",
          color: "var(--text)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--text)",
              }}
            >
              Install Skill
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 2,
              }}
            >
              Add skills from the marketplace or a GitHub repository.
            </div>
          </div>
          <button
            type="button"
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div
          className="flex"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {(
            [
              { id: "search" as const, label: "MARKETPLACE" },
              { id: "url" as const, label: "GITHUB URL" },
            ] as const
          ).map((t) => (
            <button
              type="button"
              key={t.id}
              style={{
                flex: 1,
                padding: "10px 16px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.1em",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                borderBottom:
                  tab === t.id ? "2px solid #f0b232" : "2px solid transparent",
                color: tab === t.id ? "#f0b232" : "var(--muted)",
                transition: "color 0.2s, border-color 0.2s",
              }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "search" && (
            <>
              <div className="flex gap-2 items-center mb-4">
                <input
                  type="text"
                  className="plugins-game-search-input"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder="Search skills by keyword..."
                  value={skillsMarketplaceQuery}
                  onChange={(e) =>
                    setState("skillsMarketplaceQuery", e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchSkillsMarketplace();
                  }}
                />
                <button
                  type="button"
                  className="plugins-game-chip"
                  style={{ minHeight: 36, padding: "0 16px", fontWeight: 700 }}
                  onClick={() => searchSkillsMarketplace()}
                  disabled={skillsMarketplaceLoading}
                >
                  {skillsMarketplaceLoading ? "Searching..." : "Search"}
                </button>
              </div>

              {skillsMarketplaceError && (
                <div
                  className="p-2.5 text-xs mb-3"
                  style={{ border: "1px solid #e74c3c", color: "#e74c3c" }}
                >
                  {skillsMarketplaceError}
                </div>
              )}

              {skillsMarketplaceResults.length === 0 ? (
                <div className="text-center py-12">
                  <div
                    style={{
                      color: "var(--muted)",
                      fontSize: 12,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    Search above to discover skills.
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-[11px] text-[var(--muted)] mb-1">
                    {skillsMarketplaceResults.length} {t("skillsview.result")}
                    {skillsMarketplaceResults.length !== 1 ? "s" : ""}
                  </div>
                  {skillsMarketplaceResults.map((item) => (
                    <MarketplaceCard
                      key={item.id}
                      item={item}
                      isInstalled={skills.some((s) => s.id === item.id)}
                      skillsMarketplaceAction={skillsMarketplaceAction}
                      onInstall={installSkillFromMarketplace}
                      onUninstall={uninstallMarketplaceSkill}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === "url" && (
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text)",
                  marginBottom: 4,
                }}
              >
                GitHub Repository URL
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--muted)",
                  marginBottom: 12,
                }}
              >
                Paste a full GitHub repository URL to install a skill directly.
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  className="plugins-game-search-input"
                  style={{ flex: 1 }}
                  placeholder="https://github.com/org/repo"
                  value={skillsMarketplaceManualGithubUrl}
                  onChange={(e) =>
                    setState("skillsMarketplaceManualGithubUrl", e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void installSkillFromGithubUrl();
                  }}
                />
                <button
                  type="button"
                  className="plugins-game-chip"
                  style={{ minHeight: 36, padding: "0 16px", fontWeight: 700 }}
                  onClick={() => installSkillFromGithubUrl()}
                  disabled={
                    skillsMarketplaceAction === "install:manual" ||
                    !skillsMarketplaceManualGithubUrl.trim()
                  }
                >
                  {skillsMarketplaceAction === "install:manual"
                    ? "Installing..."
                    : "Install"}
                </button>
              </div>

              {skillsMarketplaceError && (
                <div
                  className="p-2.5 text-xs mt-3"
                  style={{ border: "1px solid #e74c3c", color: "#e74c3c" }}
                >
                  {skillsMarketplaceError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Create Skill Inline Form ───────────────────────────────────────── */

function CreateSkillForm({
  skillCreateName,
  skillCreateDescription,
  skillCreating,
  setState,
  onCancel,
  onCreate,
}: {
  skillCreateName: string;
  skillCreateDescription: string;
  skillCreating: boolean;
  setState: ReturnType<typeof useApp>["setState"];
  onCancel: () => void;
  onCreate: () => void;
}) {
  const { t } = useApp();
  return (
    <div className="border border-[var(--accent)]/40 bg-[var(--card)] mb-4">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--txt)]">
          {t("skillsview.CreateNewSkill")}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <span className="block text-[11px] text-[var(--muted)] mb-1 font-medium">
            {t("skillsview.SkillName")}{" "}
            <span className="text-[#e74c3c]">*</span>
          </span>
          <Input
            className="w-full bg-bg/50 border-border/50 focus-visible:ring-accent"
            placeholder={t("skillsview.eGMyAwesomeSkil")}
            value={skillCreateName}
            onChange={(e) => setState("skillCreateName", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && skillCreateName.trim()) onCreate();
            }}
          />
        </div>
        <div>
          <span className="block text-[11px] text-[var(--muted)] mb-1 font-medium">
            {t("skillsview.Description")}
          </span>
          <Input
            className="w-full bg-bg/50 border-border/50 focus-visible:ring-accent"
            placeholder={t("skillsview.BriefDescriptionOf")}
            value={skillCreateDescription}
            onChange={(e) => setState("skillCreateDescription", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && skillCreateName.trim()) onCreate();
            }}
          />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("onboarding.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onCreate}
            disabled={skillCreating || !skillCreateName.trim()}
          >
            {skillCreating ? "Creating..." : "Create Skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Edit Skill Modal ──────────────────────────────────────────────── */

function EditSkillModal({
  skillId,
  skillName,
  onClose,
  onSaved,
}: {
  skillId: string;
  skillName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useApp();
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  const loadSource = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await client.getSkillSource(skillId);
      setContent(res.content);
      setOriginalContent(res.content);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load skill source",
      );
    }
    setLoading(false);
  }, [skillId]);

  useEffect(() => {
    void loadSource();
  }, [loadSource]);

  const hasChanges = content !== originalContent;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaveSuccess(false);
    try {
      await client.saveSkillSource(skillId, content);
      setOriginalContent(content);
      setSaveSuccess(true);
      onSaved();
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (hasChanges && !saving) void handleSave();
    }
    // Allow tab to insert spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      setContent(`${val.substring(0, start)}  ${val.substring(end)}`);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden mx-4 rounded-xl"
        style={{
          background: "color-mix(in srgb, var(--bg) 96%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
          backdropFilter: "blur(24px)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="font-semibold text-sm truncate"
              style={{ color: "var(--text)" }}
            >
              {skillName}
            </div>
            <span
              className="text-[10px] font-mono px-1.5 py-0.5"
              style={{
                color: "var(--muted)",
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              {t("skillsview.SKILLMd")}
            </span>
            {hasChanges && (
              <span
                className="text-[10px] font-medium"
                style={{ color: "#f0b232" }}
              >
                {t("skillsview.unsaved")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px]" style={{ color: "var(--muted)" }}>
              {navigator.platform.includes("Mac") ? "⌘S" : "Ctrl+S"}{" "}
              {t("skillsview.toSave")}
            </span>
            <button
              type="button"
              className="bg-transparent border-0 cursor-pointer text-lg px-2 transition-colors"
              style={{ color: "var(--muted)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--muted)";
              }}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        {/* Editor body */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div
              className="flex items-center justify-center h-full text-sm"
              style={{ color: "var(--muted)" }}
            >
              {t("skillsview.LoadingSkillSource")}
            </div>
          ) : error && !content ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-sm font-medium" style={{ color: "#ef4444" }}>
                {error}
              </div>
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors"
                style={{
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
                onClick={() => loadSource()}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <textarea
              className="w-full h-full resize-none border-0 text-[13px] leading-relaxed font-mono p-5 focus:outline-none"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text)",
              }}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            {content ? `${content.split("\n").length} lines` : ""}
            {error && content ? (
              <span className="ml-3" style={{ color: "#ef4444" }}>
                {error}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors"
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--muted)",
              }}
              onClick={onClose}
            >
              {hasChanges ? "Discard" : "Close"}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors"
              style={{
                background: saveSuccess ? "#22c55e" : "#f0b232",
                border: "none",
                color: saveSuccess ? "#fff" : "#000",
                opacity: saving || !hasChanges ? 0.5 : 1,
              }}
              onClick={() => handleSave()}
              disabled={saving || !hasChanges}
            >
              {saving ? "Saving..." : saveSuccess ? "Saved" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Main Skills View ───────────────────────────────────────────────── */

export function SkillsView({ inModal }: { inModal?: boolean } = {}) {
  if (inModal) return <SkillsModalView />;
  return <SkillsFullView />;
}

/* ── Companion Modal View (sidebar + detail, reuses plugins-game-* CSS) ── */

function SkillsModalView() {
  const {
    skills,
    skillToggleAction,
    loadSkills,
    handleSkillToggle,
    handleDeleteSkill,
    refreshSkills,
    setState,
    skillsMarketplaceQuery,
    skillsMarketplaceResults,
    skillsMarketplaceError,
    skillsMarketplaceLoading,
    skillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    searchSkillsMarketplace,
    installSkillFromMarketplace,
    uninstallMarketplaceSkill,
    installSkillFromGithubUrl,
  } = useApp();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "on" | "off">("all");
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const searchLower = filterText.toLowerCase();
    return skills.filter((s) => {
      if (filterTab === "on" && !s.enabled) return false;
      if (filterTab === "off" && s.enabled) return false;
      if (
        searchLower &&
        !s.name.toLowerCase().includes(searchLower) &&
        !(s.description ?? "").toLowerCase().includes(searchLower)
      )
        return false;
      return true;
    });
  }, [skills, filterText, filterTab]);

  const effectiveSelectedId =
    selectedId && filtered.find((s) => s.id === selectedId)
      ? selectedId
      : (filtered[0]?.id ?? null);
  const selected = effectiveSelectedId
    ? (skills.find((s) => s.id === effectiveSelectedId) ?? null)
    : null;

  const tabs: { key: typeof filterTab; label: string }[] = [
    { key: "all", label: `ALL (${skills.length})` },
    { key: "on", label: `ON (${skills.filter((s) => s.enabled).length})` },
    { key: "off", label: `OFF (${skills.filter((s) => !s.enabled).length})` },
  ];

  return (
    <div className="plugins-game-modal">
      {/* ── Left sidebar ── */}
      <div className="plugins-game-list-panel">
        <div className="plugins-game-list-head">
          <div className="plugins-game-section-title">Talents</div>
          <div className="plugins-game-section-meta">
            {skills.length} installed
          </div>
        </div>

        {/* Search + Install */}
        <div className="plugins-game-list-search">
          <div className="plugins-game-list-search-row">
            <input
              type="text"
              placeholder="Search skills..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="plugins-game-search-input"
            />
            <button
              type="button"
              className="plugins-game-chip plugins-game-add-btn"
              onClick={() => setInstallModalOpen(true)}
            >
              <span className="plugins-game-add-symbol">+</span> Install
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="plugins-game-chip-row">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`plugins-game-chip plugins-game-chip-small${filterTab === tab.key ? " is-active" : ""}`}
              onClick={() => setFilterTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Skill list */}
        <div className="plugins-game-list-scroll">
          {filtered.length === 0 ? (
            <div className="plugins-game-list-empty">No skills found</div>
          ) : (
            filtered.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className={`plugins-game-card${effectiveSelectedId === skill.id ? " is-selected" : ""}${!skill.enabled ? " is-disabled" : ""}`}
                onClick={() => setSelectedId(skill.id)}
              >
                <div className="plugins-game-card-icon-shell">
                  <span className="plugins-game-card-icon">
                    {skill.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="plugins-game-card-body">
                  <div className="plugins-game-card-name">{skill.name}</div>
                  <div className="plugins-game-card-meta">
                    <span
                      className={`plugins-game-badge ${skill.enabled ? "is-on" : "is-off"}`}
                    >
                      {skill.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right detail panel ── */}
      <div className="plugins-game-detail-panel">
        {selected ? (
          <>
            <div className="plugins-game-detail-head">
              <div className="plugins-game-detail-title-row">
                <div className="plugins-game-detail-icon-shell">
                  <span className="plugins-game-detail-icon">
                    {selected.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="plugins-game-detail-main">
                  <div className="plugins-game-detail-name">
                    {selected.name}
                  </div>
                </div>
                <button
                  type="button"
                  className={`plugins-game-toggle ${selected.enabled ? "is-on" : "is-off"}`}
                  onClick={() =>
                    handleSkillToggle(selected.id, !selected.enabled)
                  }
                  disabled={skillToggleAction === selected.id}
                >
                  {skillToggleAction === selected.id
                    ? "..."
                    : selected.enabled
                      ? "ON"
                      : "OFF"}
                </button>
              </div>
            </div>
            <div className="plugins-game-detail-description">
              {selected.description || "No description provided."}
            </div>
            <div className="plugins-game-detail-actions">
              <button
                type="button"
                className="plugins-game-action-btn"
                onClick={() => setEditingSkill(selected)}
              >
                Edit Source
              </button>
              <button
                type="button"
                className="plugins-game-action-btn"
                onClick={() => handleDeleteSkill(selected.id, selected.name)}
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <div className="plugins-game-detail-empty">
            <span className="plugins-game-detail-empty-icon">🧠</span>
            <span className="plugins-game-detail-empty-text">
              Select a talent to configure
            </span>
          </div>
        )}
      </div>

      {/* Portal modals to body so they escape the 3D transform stacking context */}
      {editingSkill &&
        createPortal(
          <EditSkillModal
            skillId={editingSkill.id}
            skillName={editingSkill.name}
            onClose={() => setEditingSkill(null)}
            onSaved={() => void refreshSkills()}
          />,
          document.body,
        )}

      {installModalOpen &&
        createPortal(
          <InstallModal
            skills={skills}
            skillsMarketplaceQuery={skillsMarketplaceQuery}
            skillsMarketplaceResults={skillsMarketplaceResults}
            skillsMarketplaceError={skillsMarketplaceError}
            skillsMarketplaceLoading={skillsMarketplaceLoading}
            skillsMarketplaceAction={skillsMarketplaceAction}
            skillsMarketplaceManualGithubUrl={skillsMarketplaceManualGithubUrl}
            searchSkillsMarketplace={searchSkillsMarketplace}
            installSkillFromMarketplace={installSkillFromMarketplace}
            uninstallMarketplaceSkill={uninstallMarketplaceSkill}
            installSkillFromGithubUrl={installSkillFromGithubUrl}
            setState={setState}
            onClose={() => setInstallModalOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/* ── Full-Page Skills View ─────────────────────────────────────────── */

function SkillsFullView() {
  const { setTimeout: _setTimeout } = useTimeout();

  const {
    skills,
    skillCreateFormOpen,
    skillCreateName,
    skillCreateDescription,
    skillCreating,
    skillReviewReport,
    skillReviewId,
    skillReviewLoading,
    skillToggleAction,
    skillsMarketplaceQuery,
    skillsMarketplaceResults,
    skillsMarketplaceError,
    skillsMarketplaceLoading,
    skillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    searchSkillsMarketplace,
    installSkillFromMarketplace,
    uninstallMarketplaceSkill,
    installSkillFromGithubUrl,
    setState,
  } = useApp();

  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // Group into: needs attention, active, inactive — with text filter
  const { attention, active, inactive, activeCount, totalCount } =
    useMemo(() => {
      const attention: SkillInfo[] = [];
      const active: SkillInfo[] = [];
      const inactive: SkillInfo[] = [];
      let activeCount = 0;

      const query = filterText.toLowerCase();

      for (const skill of skills) {
        if (
          query &&
          !skill.name.toLowerCase().includes(query) &&
          !skill.description?.toLowerCase().includes(query)
        ) {
          continue;
        }

        if (skill.enabled) activeCount++;

        if (
          skill.scanStatus === "warning" ||
          skill.scanStatus === "critical" ||
          skill.scanStatus === "blocked"
        ) {
          attention.push(skill);
        } else if (skill.enabled) {
          active.push(skill);
        } else {
          inactive.push(skill);
        }
      }

      return {
        attention,
        active,
        inactive,
        activeCount,
        totalCount: skills.length,
      };
    }, [skills, filterText]);

  const handleDismissReview = () => {
    setState("skillReviewId", "");
    setState("skillReviewReport", null);
  };

  const handleCancelCreate = () => {
    setState("skillCreateFormOpen", false);
    setState("skillCreateName", "");
    setState("skillCreateDescription", "");
  };

  const allVisible = [...attention, ...active, ...inactive];

  /** Render a group of skill cards in a grid with a section header. */
  const renderGroup = (label: string, items: SkillInfo[], accent?: string) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-6">
        <div
          className="text-xs uppercase tracking-wider font-semibold mb-2 flex items-center gap-2"
          style={accent ? { color: accent } : { color: "var(--muted)" }}
        >
          {label}
          <span className="text-[10px] font-mono opacity-60">
            ({items.length})
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              skillToggleAction={skillToggleAction}
              skillReviewId={skillReviewId}
              skillReviewReport={skillReviewReport}
              skillReviewLoading={skillReviewLoading}
              onToggle={handleSkillToggle}
              onEdit={setEditingSkill}
              onDelete={handleDeleteSkill}
              onReview={handleReviewSkill}
              onAcknowledge={handleAcknowledgeSkill}
              onDismissReview={handleDismissReview}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-4 text-[11px] text-[var(--muted)]">
        <span>
          {totalCount} skill{totalCount !== 1 ? "s" : ""}
        </span>
        <span>{activeCount} active</span>
        <span>{inactive.length} inactive</span>
        {attention.length > 0 && (
          <span className="text-[#f39c12]">
            {attention.length} need{attention.length === 1 ? "s" : ""} attention
          </span>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-6 p-3 border border-border/40 bg-card/60 backdrop-blur-md rounded-2xl shadow-sm">
        <Input
          type="text"
          placeholder="Filter skills..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="w-[240px] h-9 bg-bg/50 border-border/50 focus-visible:ring-accent rounded-xl text-xs"
        />

        <span className="flex-1" />

        <Button
          variant={skillCreateFormOpen ? "ghost" : "default"}
          size="sm"
          className={
            skillCreateFormOpen
              ? "h-9 px-4 font-bold text-muted hover:text-txt"
              : "h-9 px-4 font-bold tracking-wide shadow-sm"
          }
          onClick={() => setState("skillCreateFormOpen", !skillCreateFormOpen)}
        >
          {skillCreateFormOpen ? "Cancel" : "+ New Skill"}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-9 px-4 font-bold tracking-wide shadow-sm"
          onClick={() => setInstallModalOpen(true)}
        >
          Browse Marketplace
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 px-4 font-bold text-muted hover:text-txt"
          onClick={() => refreshSkills()}
          title="Refresh Skills List"
        >
          Refresh
        </Button>
      </div>

      {/* Create form */}
      {skillCreateFormOpen && (
        <CreateSkillForm
          skillCreateName={skillCreateName}
          skillCreateDescription={skillCreateDescription}
          skillCreating={skillCreating}
          setState={setState}
          onCancel={handleCancelCreate}
          onCreate={handleCreateSkill}
        />
      )}

      {/* Skill grid — grouped by status */}
      {skills.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-[var(--muted)] text-sm mb-2">
            No Skills Installed
          </div>
          <div className="text-[var(--muted)] text-[11px] mb-4">
            Install skills from the marketplace or create your own.
          </div>
          <div className="flex justify-center gap-3">
            <Button
              variant="default"
              size="sm"
              className="h-10 px-6 font-bold tracking-wide shadow-sm"
              onClick={() => setInstallModalOpen(true)}
            >
              Browse Marketplace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 px-6 font-bold text-muted hover:text-txt"
              onClick={() => setState("skillCreateFormOpen", true)}
            >
              Create Skill
            </Button>
          </div>
        </div>
      ) : allVisible.length === 0 ? (
        <div className="text-center py-12 text-[var(--muted)] text-xs">
          No skills match filtering "{filterText}"
        </div>
      ) : (
        <div>
          {renderGroup("Needs Attention", attention, "#f39c12")}
          {renderGroup("Active", active, "var(--ok, #16a34a)")}
          {renderGroup("Inactive", inactive)}
        </div>
      )}

      {/* Edit modal */}
      {editingSkill && (
        <EditSkillModal
          skillId={editingSkill.id}
          skillName={editingSkill.name}
          onClose={() => setEditingSkill(null)}
          onSaved={() => void refreshSkills()}
        />
      )}

      {/* Install modal */}
      {installModalOpen && (
        <InstallModal
          skills={skills}
          skillsMarketplaceQuery={skillsMarketplaceQuery}
          skillsMarketplaceResults={skillsMarketplaceResults}
          skillsMarketplaceError={skillsMarketplaceError}
          skillsMarketplaceLoading={skillsMarketplaceLoading}
          skillsMarketplaceAction={skillsMarketplaceAction}
          skillsMarketplaceManualGithubUrl={skillsMarketplaceManualGithubUrl}
          searchSkillsMarketplace={searchSkillsMarketplace}
          installSkillFromMarketplace={installSkillFromMarketplace}
          uninstallMarketplaceSkill={uninstallMarketplaceSkill}
          installSkillFromGithubUrl={installSkillFromGithubUrl}
          setState={setState}
          onClose={() => setInstallModalOpen(false)}
        />
      )}
    </div>
  );
}
