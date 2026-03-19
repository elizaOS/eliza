import { client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CharacterRoster,
  CHARACTER_PRESET_META,
  resolveRosterEntries,
  type CharacterRosterEntry,
} from "../CharacterRoster";

export function IdentityStep() {
  const {
    onboardingOptions,
    onboardingStyle,
    handleOnboardingNext,
    setState,
    t,
  } = useApp();

  const styles = onboardingOptions?.styles ?? [];
  const selectedCatchphrase = onboardingStyle || styles[0]?.catchphrase || "";

  const rosterEntries = useMemo(
    () => resolveRosterEntries(styles).slice(0, 4),
    [styles],
  );

  /* ── Import / restore state ─────────────────────────────────────── */
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const importBusyRef = useRef(false);

  const handleImportAgent = useCallback(async () => {
    if (importBusyRef.current || importBusy) return;
    if (!importFile) {
      setImportError(t("onboarding.selectFileError"));
      return;
    }
    if (!importPassword || importPassword.length < 4) {
      setImportError(t("onboarding.passwordMinError"));
      return;
    }
    try {
      importBusyRef.current = true;
      setImportBusy(true);
      setImportError(null);
      setImportSuccess(null);
      const fileBuffer = await importFile.arrayBuffer();
      const result = await client.importAgent(importPassword, fileBuffer);
      const counts = result.counts;
      const summary = [
        counts.memories ? `${counts.memories} memories` : null,
        counts.entities ? `${counts.entities} entities` : null,
        counts.rooms ? `${counts.rooms} rooms` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setImportSuccess(
        `Imported "${result.agentName}" successfully${summary ? `: ${summary}` : ""}. Restarting...`,
      );
      setImportPassword("");
      setImportFile(null);
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  }, [importBusy, importFile, importPassword, t]);

  const handleSelect = useCallback(
    (entry: CharacterRosterEntry) => {
      setState("onboardingStyle", entry.id);
      const meta = CHARACTER_PRESET_META[entry.id];
      if (meta) {
        setState("onboardingName", meta.name);
        setState("selectedVrmIndex", meta.avatarIndex);
      }
    },
    [setState],
  );

  // Auto-select the first one if nothing is selected yet
  useEffect(() => {
    if (!onboardingStyle && rosterEntries.length > 0) {
      handleSelect(rosterEntries[0]);
    }
  }, [onboardingStyle, rosterEntries, handleSelect]);

  /* ── Import UI ──────────────────────────────────────────────────── */
  if (showImport) {
    return (
      <div className="flex flex-col items-center gap-3 w-full max-w-[400px]">
        <div className="onboarding-section-title">
          {t("onboarding.importAgent")}
        </div>
        <div className="onboarding-divider">
          <div className="onboarding-divider-diamond" />
        </div>

        <p className="onboarding-desc mb-1">{t("onboarding.importDesc")}</p>

        <input
          type="file"
          accept=".eliza-agent"
          onChange={(e) => {
            setImportFile(e.target.files?.[0] ?? null);
            setImportError(null);
          }}
          className="onboarding-input text-[13px] text-left"
        />

        <input
          type="password"
          placeholder={t("onboarding.decryptionPasswordPlaceholder")}
          value={importPassword}
          onChange={(e) => {
            setImportPassword(e.target.value);
            setImportError(null);
          }}
          className="onboarding-input"
        />

        {importError && (
          <p className="onboarding-desc text-[var(--danger)] !mb-0">
            {importError}
          </p>
        )}
        {importSuccess && (
          <p className="onboarding-desc text-[var(--ok)] !mb-0">
            {importSuccess}
          </p>
        )}

        <div className="flex gap-3 mt-2">
          <button
            className="onboarding-back-link"
            onClick={() => {
              setShowImport(false);
              setImportError(null);
              setImportSuccess(null);
              setImportFile(null);
              setImportPassword("");
            }}
            type="button"
          >
            {t("onboarding.cancel")}
          </button>
          <button
            className="onboarding-confirm-btn"
            disabled={importBusy || !importFile}
            onClick={() => void handleImportAgent()}
            type="button"
          >
            {importBusy ? t("onboarding.importing") : t("onboarding.restore")}
          </button>
        </div>
      </div>
    );
  }

  /* ── Character roster ───────────────────────────────────────────── */
  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-[640px]">
      <CharacterRoster
        entries={rosterEntries}
        selectedId={selectedCatchphrase}
        onSelect={handleSelect}
        variant="onboarding"
        testIdPrefix="onboarding"
      />

      <p className="onboarding-desc !mt-0 !mb-0">
        You can customize your character later.
      </p>

      {/* ── Next button ── */}
      <button
        className="onboarding-confirm-btn w-full max-w-[320px]"
        onClick={() => handleOnboardingNext()}
        type="button"
      >
        Next
      </button>

      {/* ── Restore from backup link ── */}
      <button
        type="button"
        onClick={() => setShowImport(true)}
        className="bg-transparent border-none text-white/40 text-xs cursor-pointer underline py-1"
      >
        {t("onboarding.restoreFromBackup")}
      </button>
    </div>
  );
}
