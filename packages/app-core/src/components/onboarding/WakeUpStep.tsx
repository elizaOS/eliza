import { client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useCallback, useRef, useState } from "react";

export function WakeUpStep() {
  const { handleOnboardingNext, t } = useApp();

  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const importFileRef = useRef<HTMLInputElement>(null);
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

  if (showImport) {
    return (
      <>
        <div className="onboarding-section-title">
          {t("onboarding.importAgent")}
        </div>
        <div className="onboarding-divider">
          <div className="onboarding-divider-diamond" />
        </div>

        <p className="onboarding-desc" style={{ marginBottom: "16px" }}>
          {t("onboarding.importDesc")}
        </p>

        <input
          ref={importFileRef}
          type="file"
          accept=".eliza-agent"
          onChange={(e) => {
            setImportFile(e.target.files?.[0] ?? null);
            setImportError(null);
          }}
          className="onboarding-input"
          style={{ fontSize: "13px", textAlign: "left", marginBottom: "12px" }}
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
          style={{ marginBottom: "12px" }}
        />

        {importError && (
          <p
            className="onboarding-desc"
            style={{ color: "var(--danger)", marginBottom: "8px" }}
          >
            {importError}
          </p>
        )}
        {importSuccess && (
          <p
            className="onboarding-desc"
            style={{ color: "var(--ok)", marginBottom: "8px" }}
          >
            {importSuccess}
          </p>
        )}

        <div className="onboarding-panel-footer">
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
      </>
    );
  }

  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.welcomeTitle")}
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>

      <p className="onboarding-desc">{t("onboarding.welcomeSubtitle")}</p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "100%",
          marginTop: "16px",
        }}
      >
        <button
          className="onboarding-confirm-btn"
          onClick={() => handleOnboardingNext()}
          type="button"
          style={{ width: "100%" }}
        >
          {t("onboarding.createNewAgent")}
        </button>
        <button
          className="onboarding-confirm-btn"
          onClick={() => setShowImport(true)}
          type="button"
          style={{
            width: "100%",
            background: "transparent",
            border: "1px solid var(--border)",
          }}
        >
          {t("onboarding.restoreFromBackup")}
        </button>
      </div>
    </>
  );
}
