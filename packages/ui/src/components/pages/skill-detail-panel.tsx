/**
 * Skill detail panel — edit modal and companion modal view.
 *
 * Extracted from SkillsView.tsx to keep individual files under ~500 LOC.
 */

import { AdminCodeEditor, AdminDialogContent, AdminDialogHeader, AdminMonoMeta } from "../ui/admin-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillInfo } from "../../api";
import { client } from "../../api";
import { useApp } from "../../state";
import { InstallModal } from "./skill-marketplace";

const BINANCE_SKILL_IDS = new Set([
  "binance-crypto-market-rank",
  "binance-meme-rush",
  "binance-query-address-info",
  "binance-query-token-audit",
  "binance-query-token-info",
  "binance-trading-signal",
]);

/* ── Edit Skill Modal ──────────────────────────────────────────────── */

export function EditSkillModal({
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
        err instanceof Error
          ? err.message
          : t("skillsview.failedToLoadSkillSource", {
              defaultValue: "Failed to load skill source",
            }),
      );
    }
    setLoading(false);
  }, [skillId, t]);

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
      setError(
        err instanceof Error
          ? err.message
          : t("skillsview.failedToSave", {
              defaultValue: "Failed to save",
            }),
      );
    }
    setSaving(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (hasChanges && !saving) void handleSave();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <AdminDialogContent
        container={typeof document !== "undefined" ? document.body : undefined}
        className="h-[85vh] max-w-4xl"
      >
        <AdminDialogHeader className="flex-row items-center justify-between py-3 space-y-0">
          <div className="flex items-center gap-3 min-w-0">
            <DialogTitle className="font-semibold text-sm truncate">
              {skillName}
            </DialogTitle>
            <AdminMonoMeta className="rounded-md border border-border bg-bg-hover px-1.5 py-0.5">
              {t("skillsview.SKILLMd")}
            </AdminMonoMeta>
            <DialogDescription className="sr-only">
              {t("skillsview.editSkillSourceDescription", {
                defaultValue:
                  "Edit the Markdown source for this skill and save your changes.",
              })}
            </DialogDescription>
            {hasChanges && (
              <span className="text-2xs font-medium text-warn">
                {t("skillsview.unsaved")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted">
              {navigator.platform.includes("Mac") ? "\u2318S" : "Ctrl+S"}{" "}
              {t("skillsview.toSave")}
            </span>
          </div>
        </AdminDialogHeader>
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {t("skillsview.LoadingSkillSource")}
            </div>
          ) : error && !content ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="text-sm font-medium text-danger">{error}</div>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => loadSource()}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <AdminCodeEditor
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between px-5 py-3">
          <div className="text-xs-tight text-muted">
            {content
              ? `${content.split("\n").length} ${t("trajectorydetailview.lines")}`
              : ""}
            {error && content ? (
              <span className="ml-3 text-danger">{error}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={onClose}
            >
              {hasChanges
                ? t("skillsview.discard", { defaultValue: "Discard" })
                : t("common.close")}
            </Button>
            <Button
              variant="default"
              size="sm"
              className={`text-xs font-medium ${
                saveSuccess
                  ? "border-ok/40 bg-ok text-white hover:bg-ok/90"
                  : ""
              }`}
              onClick={() => handleSave()}
              disabled={saving || !hasChanges}
            >
              {saving
                ? t("common.saving")
                : saveSuccess
                  ? t("common.saved")
                  : t("common.save")}
            </Button>
          </div>
        </div>
      </AdminDialogContent>
    </Dialog>
  );
}

/* ── Companion Modal View (sidebar + detail, reuses plugins-game-* CSS) ── */

export function SkillsModalView() {
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
    enableMarketplaceSkill,
    disableMarketplaceSkill,
    copyMarketplaceSkillSource,
    t,
  } = useApp();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "on" | "off" | "binance">(
    "all",
  );
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
      if (filterTab === "binance" && !BINANCE_SKILL_IDS.has(s.id)) return false;
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
    {
      key: "all",
      label: `${t("common.all", { defaultValue: "All" })} (${skills.length})`,
    },
    {
      key: "on",
      label: `${t("common.on")} (${skills.filter((s) => s.enabled).length})`,
    },
    {
      key: "off",
      label: `${t("common.off")} (${skills.filter((s) => !s.enabled).length})`,
    },
  ];

  return (
    <div className="plugins-game-modal">
      <div className="plugins-game-list-panel">
        <div className="plugins-game-list-head">
          <div className="plugins-game-section-title">
            {t("skillsview.Talents", { defaultValue: "Talents" })}
          </div>
          <div className="plugins-game-section-meta">
            {skills.length}{" "}
            {t("skillsview.installed", { defaultValue: "installed" })}
          </div>
        </div>
        <div className="plugins-game-list-search">
          <div className="plugins-game-list-search-row">
            <Input
              type="text"
              placeholder={t("skillsview.SearchSkills", {
                defaultValue: "Search skills...",
              })}
              aria-label={t("skillsview.SearchSkills", {
                defaultValue: "Search skills",
              })}
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="plugins-game-search-input"
            />
            <Button
              variant="default"
              size="sm"
              type="button"
              className="plugins-game-chip plugins-game-add-btn"
              onClick={() => setInstallModalOpen(true)}
            >
              <span className="plugins-game-add-symbol">+</span>{" "}
              {t("common.install", { defaultValue: "Install" })}
            </Button>
          </div>
        </div>
        <div className="plugins-game-chip-row">
          {tabs.map((tab) => (
            <Button
              variant="ghost"
              size="sm"
              key={tab.key}
              type="button"
              className={`plugins-game-chip plugins-game-chip-small${filterTab === tab.key ? " is-active" : ""}`}
              onClick={() => setFilterTab(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div
          className="plugins-game-list-scroll"
          role="listbox"
          aria-label={t("skillsview.Talents", {
            defaultValue: "Installed skills",
          })}
        >
          {filtered.length === 0 ? (
            <div className="plugins-game-list-empty">
              {t("skillsview.NoSkillsFound", {
                defaultValue: "No skills found",
              })}
            </div>
          ) : (
            filtered.map((skill) => (
              <Button
                variant="ghost"
                key={skill.id}
                type="button"
                role="option"
                aria-selected={effectiveSelectedId === skill.id}
                className={`plugins-game-card${effectiveSelectedId === skill.id ? " is-selected" : ""}${!skill.enabled ? " is-disabled" : ""} h-auto`}
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
                      {skill.enabled ? t("common.on") : t("common.off")}
                    </span>
                  </div>
                </div>
              </Button>
            ))
          )}
        </div>
      </div>
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
                <Button
                  variant="ghost"
                  size="sm"
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
                      ? t("common.on")
                      : t("common.off")}
                </Button>
              </div>
            </div>
            <div className="plugins-game-detail-description">
              {selected.description ||
                t("skillsview.noDescriptionProvided", {
                  defaultValue: "No description provided.",
                })}
            </div>
            <div className="plugins-game-detail-actions">
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="plugins-game-action-btn"
                onClick={() => setEditingSkill(selected)}
              >
                {t("skillsview.EditSource", { defaultValue: "Edit Source" })}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                className="plugins-game-action-btn"
                onClick={() => handleDeleteSkill(selected.id, selected.name)}
              >
                {t("common.delete", { defaultValue: "Delete" })}
              </Button>
            </div>
          </>
        ) : (
          <div className="plugins-game-detail-empty">
            <span className="plugins-game-detail-empty-icon">🧠</span>
            <span className="plugins-game-detail-empty-text">
              {t("skillsview.SelectATalentToConf", {
                defaultValue: "Select a talent to configure",
              })}
            </span>
          </div>
        )}
      </div>

      {editingSkill && (
        <EditSkillModal
          skillId={editingSkill.id}
          skillName={editingSkill.name}
          onClose={() => setEditingSkill(null)}
          onSaved={() => void refreshSkills()}
        />
      )}

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
          enableSkill={enableMarketplaceSkill}
          disableSkill={disableMarketplaceSkill}
          copySkillSource={copyMarketplaceSkillSource}
          showSkillDetails={(_skillId: string) => {
            setInstallModalOpen(false);
          }}
          setState={setState}
          onClose={() => setInstallModalOpen(false)}
        />
      )}
    </div>
  );
}
