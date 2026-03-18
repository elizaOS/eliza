/**
 * Pairing view component — simple pairing screen for authentication.
 */

import { useBranding } from "../config/branding";
import { useApp } from "../state";

export function PairingView() {
  const {
    pairingEnabled,
    pairingExpiresAt,
    pairingCodeInput,
    pairingError,
    pairingBusy,
    handlePairingSubmit,
    setState,
    t,
  } = useApp();
  const branding = useBranding();

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setState("pairingCodeInput", e.target.value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handlePairingSubmit();
  };

  const formatExpiry = (timestamp: number | null): string => {
    if (!timestamp) return "";
    const now = Date.now();
    const diff = timestamp - now;
    if (diff <= 0) return "Expired";
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `Expires in ${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <div className="max-w-[560px] mx-auto mt-15 p-6 border border-border bg-card rounded-[10px]">
      <h1 className="text-lg font-semibold mb-2 text-txt-strong">
        {t("pairingview.PairingRequired")}
      </h1>
      <p className="text-muted mb-4 leading-relaxed">
        {t("pairingview.EnterThePairingCo")}
      </p>

      {pairingEnabled ? (
        <form onSubmit={handleSubmit}>
          <div>
            <label
              htmlFor="pairing-code"
              className="text-sm text-txt-strong block mb-2"
            >
              {t("pairingview.PairingCode")}
            </label>
            <input
              id="pairing-code"
              type="text"
              value={pairingCodeInput}
              onChange={handleCodeChange}
              placeholder={t("pairingview.EnterPairingCode")}
              disabled={pairingBusy}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-bg-muted text-txt text-sm focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div className="mt-3 flex gap-2.5">
            <button
              type="submit"
              className="px-6 py-2 border border-accent bg-accent text-accent-fg text-sm cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={pairingBusy || !pairingCodeInput.trim()}
            >
              {pairingBusy ? "Pairing..." : "Submit"}
            </button>
          </div>

          {pairingError && (
            <p className="mt-2.5 text-danger text-[13px]">{pairingError}</p>
          )}

          {pairingExpiresAt && (
            <p className="mt-2.5 text-muted text-[13px]">
              {formatExpiry(pairingExpiresAt)}
            </p>
          )}
        </form>
      ) : (
        <div className="text-muted text-sm space-y-2">
          <p>{t("pairingview.PairingIsNotEnabl")}</p>
          <p>{t("pairingview.NextSteps")}</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>{t("pairingview.AskTheServerOwner")}</li>
            <li>{t("pairingview.EnablePairingOnTh")}</li>
          </ol>
          <a
            href={`https://github.com/${branding.orgName}/${branding.repoName}/blob/develop/docs/api-reference.mdx`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex px-3 py-2 border border-border rounded text-txt hover:border-accent hover:text-txt"
          >
            {t("pairingview.PairingSetupDocs")}
          </a>
        </div>
      )}
    </div>
  );
}
