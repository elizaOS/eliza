import { useApp } from "@elizaos/app-core/state";
import { useState } from "react";

type RpcMode = "" | "cloud" | "byok";

export function RpcStep() {
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    onboardingRunMode,
    onboardingCloudProvider,
    onboardingApiKey,
    handleCloudLogin,
    handleOnboardingNext,
    handleOnboardingBack,
    onboardingRpcKeys,
    setState,
    t,
  } = useApp();

  const elizaCloudReady =
    elizaCloudConnected ||
    (onboardingRunMode === "cloud" &&
      onboardingCloudProvider === "elizacloud" &&
      onboardingApiKey.trim().length > 0);
  const [mode, setMode] = useState<RpcMode>(elizaCloudReady ? "cloud" : "");

  const rpcKeys = onboardingRpcKeys as Record<string, string>;

  const setRpcKey = (key: string, value: string) => {
    setState("onboardingRpcKeys", { ...rpcKeys, [key]: value });
  };

  const handleSkip = () => {
    // Clear any partial RPC config and advance
    void handleOnboardingNext();
  };

  // ── No mode chosen yet — show two option cards ──────────────────────
  if (!mode) {
    return (
      <>
        <div className="onboarding-section-title">
          {t("onboarding.rpcTitle")}
        </div>
        <div className="onboarding-divider">
          <div className="onboarding-divider-diamond" />
        </div>
        <div className="onboarding-question">{t("onboarding.rpcQuestion")}</div>
        <p className="onboarding-desc">{t("onboarding.rpcDesc")}</p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            width: "100%",
            maxWidth: "22rem",
            margin: "0 auto",
          }}
        >
          {/* Eliza Cloud option */}
          <button
            type="button"
            className="onboarding-provider-card onboarding-provider-card--recommended"
            onClick={() => {
              if (elizaCloudConnected) {
                // Already connected — just mark cloud and advance
                setState("onboardingRpcSelections", {
                  evm: "eliza-cloud",
                  bsc: "eliza-cloud",
                  solana: "eliza-cloud",
                });
                setMode("cloud");
              } else {
                setMode("cloud");
              }
            }}
            style={{ justifyContent: "center" }}
          >
            <div>
              <div className="onboarding-provider-name">
                {t("onboarding.rpcElizaCloud")}
              </div>
              <div className="onboarding-provider-desc">
                {t("onboarding.rpcElizaCloudDesc")}
              </div>
            </div>
          </button>

          {/* BYOK option */}
          <button
            type="button"
            className="onboarding-provider-card"
            onClick={() => setMode("byok")}
            style={{ justifyContent: "center" }}
          >
            <div>
              <div className="onboarding-provider-name">
                {t("onboarding.rpcBringKeys")}
              </div>
              <div className="onboarding-provider-desc">
                Alchemy, QuickNode, Helius
              </div>
            </div>
          </button>
        </div>

        <div className="onboarding-panel-footer">
          <button
            className="onboarding-back-link"
            onClick={handleOnboardingBack}
            type="button"
          >
            {t("onboarding.back")}
          </button>
          <button
            className="onboarding-back-link"
            onClick={handleSkip}
            type="button"
          >
            {t("onboarding.rpcSkip")}
          </button>
        </div>
      </>
    );
  }

  // ── Eliza Cloud mode ───────────────────────────────────────────────
  if (mode === "cloud") {
    return (
      <>
        <div className="onboarding-section-title">
          {t("onboarding.rpcTitle")}
        </div>
        <div className="onboarding-divider">
          <div className="onboarding-divider-diamond" />
        </div>

        <div style={{ width: "100%", textAlign: "center" }}>
          {elizaCloudConnected ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.625rem 1rem",
                border: "1px solid var(--ok-muted)",
                background: "var(--ok-subtle)",
                color: "var(--ok)",
                fontSize: "0.875rem",
                borderRadius: "0.5rem",
                justifyContent: "center",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>{t("onboarding.connected")}</title>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {t("onboarding.rpcConnectedCloud")}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="onboarding-confirm-btn"
                onClick={handleCloudLogin}
                disabled={elizaCloudLoginBusy || elizaCloudReady}
              >
                {elizaCloudLoginBusy
                  ? t("onboarding.connecting")
                  : elizaCloudReady
                    ? t("onboarding.connected")
                    : t("onboarding.connectAccount")}
              </button>
              {elizaCloudLoginError &&
                (() => {
                  const urlMatch = elizaCloudLoginError.match(
                    /^Open this link to log in: (.+)$/,
                  );
                  if (urlMatch) {
                    return (
                      <p
                        style={{
                          fontSize: "0.8125rem",
                          marginTop: "0.5rem",
                          color: "var(--text)",
                        }}
                      >
                        Open this link to log in:{" "}
                        <a
                          href={urlMatch[1]}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: "var(--text)",
                            textDecoration: "underline",
                          }}
                        >
                          Click here
                        </a>
                      </p>
                    );
                  }
                  return (
                    <p
                      style={{
                        color: "var(--danger)",
                        fontSize: "0.8125rem",
                        marginTop: "0.5rem",
                      }}
                    >
                      {elizaCloudLoginError}
                    </p>
                  );
                })()}
              <p className="onboarding-desc">{t("onboarding.freeCredits")}</p>
            </>
          )}
        </div>

        <div className="onboarding-panel-footer">
          <button
            className="onboarding-back-link"
            onClick={() => setMode("")}
            type="button"
          >
            {t("onboarding.change")}
          </button>
          <button
            className="onboarding-confirm-btn"
            onClick={() => {
              setState("onboardingRpcSelections", {
                evm: "eliza-cloud",
                bsc: "eliza-cloud",
                solana: "eliza-cloud",
              });
              void handleOnboardingNext();
            }}
            disabled={!elizaCloudReady}
            type="button"
          >
            {t("onboarding.next") ?? "Next"}
          </button>
        </div>
      </>
    );
  }

  // ── BYOK mode ───────────────────────────────────────────────────────
  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.rpcTitle")}
        <button
          type="button"
          className="onboarding-back-link"
          style={{ marginLeft: "0.5rem", fontSize: "0.75rem" }}
          onClick={() => setMode("")}
        >
          {t("onboarding.change")}
        </button>
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>

      <div
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {/* Alchemy — all EVM chains */}
        <div>
          <label
            htmlFor="rpc-alchemy"
            style={{
              display: "block",
              fontSize: "0.8125rem",
              fontWeight: 600,
              marginBottom: "0.375rem",
              color: "var(--text)",
            }}
          >
            {t("onboarding.rpcAlchemyKey")}
          </label>
          <p
            className="onboarding-desc"
            style={{ marginBottom: "0.375rem", textAlign: "left" }}
          >
            Covers Ethereum, Base, Arbitrum, Optimism, Polygon, BSC
          </p>
          <input
            id="rpc-alchemy"
            type="password"
            className="onboarding-input"
            placeholder="Enter Alchemy API key"
            value={rpcKeys.ALCHEMY_API_KEY ?? ""}
            onChange={(e) => setRpcKey("ALCHEMY_API_KEY", e.target.value)}
          />
        </div>

        {/* Helius — Solana specific */}
        <div>
          <label
            htmlFor="rpc-helius"
            style={{
              display: "block",
              fontSize: "0.8125rem",
              fontWeight: 600,
              marginBottom: "0.375rem",
              color: "var(--text)",
            }}
          >
            {t("onboarding.rpcHeliusKey")}
          </label>
          <p
            className="onboarding-desc"
            style={{ marginBottom: "0.375rem", textAlign: "left" }}
          >
            Solana mainnet RPC &amp; token data
          </p>
          <input
            id="rpc-helius"
            type="password"
            className="onboarding-input"
            placeholder="Enter Helius API key"
            value={rpcKeys.HELIUS_API_KEY ?? ""}
            onChange={(e) => setRpcKey("HELIUS_API_KEY", e.target.value)}
          />
        </div>

        {/* Birdeye — Solana token data (optional) */}
        <div>
          <label
            htmlFor="rpc-birdeye"
            style={{
              display: "block",
              fontSize: "0.8125rem",
              fontWeight: 600,
              marginBottom: "0.375rem",
              color: "var(--text)",
            }}
          >
            {t("onboarding.rpcBirdeyeKey")}
          </label>
          <input
            id="rpc-birdeye"
            type="password"
            className="onboarding-input"
            placeholder="Enter Birdeye API key (optional)"
            value={rpcKeys.BIRDEYE_API_KEY ?? ""}
            onChange={(e) => setRpcKey("BIRDEYE_API_KEY", e.target.value)}
          />
        </div>
      </div>

      <div className="onboarding-panel-footer">
        <button
          className="onboarding-back-link"
          onClick={() => setMode("")}
          type="button"
        >
          {t("onboarding.back")}
        </button>
        <button
          className="onboarding-confirm-btn"
          onClick={() => {
            // Build RPC selections based on what keys were entered
            const selections: Record<string, string> = {};
            if (rpcKeys.ALCHEMY_API_KEY) {
              selections.evm = "alchemy";
              selections.bsc = "alchemy";
            }
            if (rpcKeys.HELIUS_API_KEY) {
              selections.solana = "helius-birdeye";
            }
            setState("onboardingRpcSelections", selections);
            void handleOnboardingNext();
          }}
          type="button"
        >
          {t("onboarding.next") ?? "Next"}
        </button>
      </div>
    </>
  );
}
