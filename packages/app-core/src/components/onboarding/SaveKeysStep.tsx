import { client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useEffect, useState } from "react";
import { CopyableAddress } from "../inventory/CopyableAddress";

interface WalletKeys {
  evmPrivateKey: string;
  evmAddress: string;
  solanaPrivateKey: string;
  solanaAddress: string;
}

export function SaveKeysStep() {
  const { handleOnboardingNext, handleOnboardingBack, copyToClipboard, t } =
    useApp();

  const [keys, setKeys] = useState<WalletKeys | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getWalletKeys()
      .then((data) => {
        if (!cancelled) {
          setKeys(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load wallet keys",
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.saveKeysTitle")}
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>
      <p className="onboarding-desc">{t("onboarding.saveKeysDesc")}</p>
      <p className="onboarding-desc text-[var(--warning)] font-medium">
        {t("onboarding.saveKeysWarning")}
      </p>

      {loading && (
        <p className="onboarding-desc">{t("onboarding.saveKeysLoading")}</p>
      )}

      {error && (
        <p className="onboarding-desc text-[var(--danger)]">{error}</p>
      )}

      {keys && (
        <div className="flex flex-col gap-4 w-full">
          {/* EVM */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">
              {t("onboarding.evmAddress")}
            </span>
            <CopyableAddress
              address={keys.evmAddress}
              onCopy={copyToClipboard}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">
              {t("onboarding.evmPrivateKey")}
            </span>
            <PrivateKeyBox value={keys.evmPrivateKey} onCopy={copyToClipboard} />
          </div>

          {/* Solana */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">
              {t("onboarding.solanaAddress")}
            </span>
            <CopyableAddress
              address={keys.solanaAddress}
              onCopy={copyToClipboard}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">
              {t("onboarding.solanaPrivateKey")}
            </span>
            <PrivateKeyBox
              value={keys.solanaPrivateKey}
              onCopy={copyToClipboard}
            />
          </div>

          <label className="flex items-center gap-2 mt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span className="onboarding-desc !mb-0 text-[13px]">
              {t("onboarding.saveKeysConfirm")}
            </span>
          </label>
        </div>
      )}

      <div className="onboarding-panel-footer">
        <button
          className="onboarding-back-link"
          onClick={() => handleOnboardingBack()}
          type="button"
        >
          {t("onboarding.back")}
        </button>
        <button
          className="onboarding-confirm-btn"
          disabled={!confirmed || loading || !!error}
          onClick={() => void handleOnboardingNext()}
          type="button"
        >
          {t("onboarding.savedMyKeys")}
        </button>
      </div>
    </>
  );
}

function PrivateKeyBox({
  value,
  onCopy,
}: {
  value: string;
  onCopy: (text: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await onCopy(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-start gap-2">
      <code className="flex-1 text-[11px] break-all bg-[var(--surface-2)] rounded px-2 py-1.5 font-mono select-all leading-relaxed">
        {value || "—"}
      </code>
      <button
        type="button"
        className="onboarding-back-link !text-[11px] shrink-0 mt-1"
        onClick={() => void handleCopy()}
        disabled={!value}
      >
        {copied ? "copied!" : "copy"}
      </button>
    </div>
  );
}
