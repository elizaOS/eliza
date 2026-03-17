import { client } from "@elizaos/app-core/api";
import { getVrmPreviewUrl, useApp } from "@elizaos/app-core/state";
import { useCallback, useEffect, useRef, useState } from "react";

/** Maps catchphrases → character metadata for onboarding. */
const IDENTITY_PRESETS: Record<string, { name: string; avatarIndex: number }> =
  {
    "Noted.": { name: "Rin", avatarIndex: 1 },
    "uwu~": { name: "Ai", avatarIndex: 2 },
    "lol k": { name: "Anzu", avatarIndex: 3 },
    "hehe~": { name: "Aya", avatarIndex: 4 },
  };

/** Identical clip-paths used by CharacterView roster cards. */
const SLANT_CLIP = "polygon(32px 0, 100% 0, calc(100% - 32px) 100%, 0 100%)";
const INSET_CLIP =
  "polygon(0px 0, 100% 0, calc(100% - 4px) 100%, -8px 100%)";

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
    (catchphrase: string) => {
      setState("onboardingStyle", catchphrase);
      const meta = IDENTITY_PRESETS[catchphrase];
      if (meta) {
        setState("onboardingName", meta.name);
        setState("selectedVrmIndex", meta.avatarIndex);
      }
    },
    [setState],
  );

  // Auto-select the first one if nothing is selected yet
  useEffect(() => {
    if (!onboardingStyle && styles.length > 0) {
      handleSelect(styles[0].catchphrase);
    }
  }, [onboardingStyle, styles, handleSelect]);

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

        <p className="onboarding-desc mb-1">
          {t("onboarding.importDesc")}
        </p>

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

  /* ── Video-game style character roster (matches CharacterView exactly) ── */
  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-[640px]">
      {/* ── Character roster grid — identical to CharacterView roster ── */}
      <div
        className="flex flex-wrap items-start justify-center gap-y-1"
        data-testid="onboarding-character-roster"
      >
        {styles.slice(0, 4).length > 0 ? (
          styles.slice(0, 4).map((preset) => {
            const meta = IDENTITY_PRESETS[preset.catchphrase];
            const isSelected = selectedCatchphrase === preset.catchphrase;
            const name = meta?.name ?? "Agent";
            const avatarIdx = meta?.avatarIndex ?? 1;

            return (
              <button
                key={preset.catchphrase}
                type="button"
                className={`group relative -mx-3 min-w-0 w-[9.75rem] text-center transition-all duration-300 ease-out ${
                  isSelected
                    ? "z-100 scale-[1.00] opacity-100"
                    : "scale-[1.00] opacity-70 hover:scale-[1.00] hover:opacity-100"
                }`}
                onClick={() => handleSelect(preset.catchphrase)}
                data-testid={`onboarding-preset-${preset.catchphrase}`}
              >
                <div
                  className={`relative h-[10rem] w-full p-[2px] transition-all duration-300 ${
                    isSelected
                      ? "bg-yellow-400 shadow-[0_0_28px_rgba(250,204,21,0.32)]"
                      : "bg-white/10 hover:bg-white/35"
                  }`}
                  style={{ clipPath: SLANT_CLIP }}
                >
                  <div
                    className="relative h-full w-full overflow-hidden"
                    style={{ clipPath: SLANT_CLIP }}
                  >
                    {isSelected && (
                      <div
                        className="pointer-events-none absolute -inset-3 bg-yellow-300/15 blur-xl"
                        style={{ clipPath: SLANT_CLIP }}
                      />
                    )}
                    <img
                      src={getVrmPreviewUrl(avatarIdx)}
                      alt={name}
                      draggable={false}
                      className={`h-full w-full object-cover transition-transform duration-300 ease-out ${
                        isSelected
                          ? "scale-[1.04]"
                          : "scale-100 group-hover:scale-[1.02]"
                      }`}
                    />
                    <div className="absolute inset-x-0 bottom-0">
                      <div
                        className={`px-2 py-1 text-sm font-semibold text-white transition-all ${
                          isSelected
                            ? "bg-black/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                            : "bg-black/62"
                        }`}
                        style={{ clipPath: INSET_CLIP }}
                      >
                        {name}
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        ) : (
          <div className="rounded-2xl border border-white/10 bg-black/10 p-4 text-sm text-white/50">
            Loading character presets...
          </div>
        )}
      </div>

      {/* ── Continue button ── */}
      <button
        className="onboarding-confirm-btn w-full max-w-[320px] mt-2"
        onClick={() => handleOnboardingNext()}
        type="button"
      >
        Continue
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
