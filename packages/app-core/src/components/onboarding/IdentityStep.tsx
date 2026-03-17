import { getVrmPreviewUrl, useApp } from "@elizaos/app-core/state";
import { useCallback, useEffect } from "react";

/** Maps catchphrases → character metadata for onboarding. */
const IDENTITY_PRESETS: Record<string, { name: string; avatarIndex: number }> =
  {
    "Noted.": { name: "Rin", avatarIndex: 1 },
    "uwu~": { name: "Ai", avatarIndex: 2 },
    "lol k": { name: "Anzu", avatarIndex: 3 },
    "hehe~": { name: "Aya", avatarIndex: 4 },
  };

export function IdentityStep() {
  const {
    onboardingOptions,
    onboardingStyle,
    handleOnboardingNext,
    setState,
    t: _t,
  } = useApp();

  const styles = onboardingOptions?.styles ?? [];

  // Resolve which preset is currently selected
  const selectedCatchphrase = onboardingStyle || styles[0]?.catchphrase || "";

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

  return (
    <>
      <div className="onboarding-section-title">Choose Your Agent</div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>

      <p className="onboarding-desc">
        Pick a personality for your agent. You can customize everything later.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px",
          width: "100%",
          marginTop: "16px",
        }}
      >
        {styles.slice(0, 4).map((preset) => {
          const meta = IDENTITY_PRESETS[preset.catchphrase];
          const isSelected = selectedCatchphrase === preset.catchphrase;
          const name = meta?.name ?? "Agent";
          const avatarIdx = meta?.avatarIndex ?? 1;

          return (
            <button
              key={preset.catchphrase}
              type="button"
              onClick={() => handleSelect(preset.catchphrase)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "6px",
                padding: "12px 8px",
                borderRadius: "12px",
                border: isSelected
                  ? "2px solid rgba(240,185,11,0.8)"
                  : "1px solid rgba(255,255,255,0.12)",
                background: isSelected
                  ? "rgba(240,185,11,0.08)"
                  : "rgba(255,255,255,0.04)",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              <img
                src={getVrmPreviewUrl(avatarIdx)}
                alt={name}
                draggable={false}
                style={{
                  width: "56px",
                  height: "56px",
                  borderRadius: "50%",
                  objectFit: "cover",
                  opacity: isSelected ? 1 : 0.65,
                  transition: "opacity 0.15s ease",
                }}
              />
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: isSelected
                    ? "rgba(240,185,11,1)"
                    : "rgba(255,255,255,0.7)",
                }}
              >
                {name}
              </span>
              <span
                style={{
                  fontSize: "11px",
                  color: "rgba(255,255,255,0.45)",
                }}
              >
                {preset.hint}
              </span>
            </button>
          );
        })}
      </div>

      <div className="onboarding-panel-footer" style={{ marginTop: "20px" }}>
        <button
          className="onboarding-confirm-btn"
          onClick={() => handleOnboardingNext()}
          type="button"
          style={{ width: "100%" }}
        >
          Continue
        </button>
      </div>
    </>
  );
}
