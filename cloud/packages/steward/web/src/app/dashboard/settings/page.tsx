"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { CodeBlock } from "@/components/code-block";
import { CopyButton } from "@/components/copy-button";
import { API_URL } from "@/lib/api";

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  56: "BNB Chain",
};

export default function SettingsPage() {
  const { address, tenant } = useAuth();
  const chainId = 8453; // Base mainnet
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const TENANT_ID = tenant?.tenantId || "";
  const API_KEY = tenant?.apiKey || "";

  async function saveWebhook(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/tenants/${TENANT_ID}/webhook`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Steward-Tenant": TENANT_ID,
          "X-Steward-Key": API_KEY,
        },
        body: JSON.stringify({ webhookUrl: webhookUrl || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const sdkSnippet = `import { StewardClient } from "@stwd/sdk"

const steward = new StewardClient({
  baseUrl: "${API_URL}",
  tenantId: "${TENANT_ID}",
  apiKey: "your-api-key",
})

// Create an agent wallet
const agent = await steward.createWallet(
  "my-agent",
  "Trading Bot"
)

// Sign a transaction (policy-checked)
const result = await steward.signTransaction(
  "my-agent",
  {
    to: "0x...",
    value: "1000000000000000", // 0.001 ETH
    chainId: 8453,
  }
)

// Get policies
const policies = await steward.getPolicies("my-agent")`;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-10"
    >
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-700 tracking-tight">Settings</h1>
        <p className="text-sm text-text-tertiary mt-1">Tenant configuration and integration</p>
      </div>

      {/* Account */}
      {address && (
        <div className="space-y-4">
          <h2 className="font-display text-sm font-600 text-text-secondary tracking-wider uppercase">
            Account
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-px bg-border">
            <div className="bg-bg p-5">
              <label className="text-xs text-text-tertiary block mb-2">Wallet</label>
              <span className="font-mono text-sm text-text-secondary break-all">{address}</span>
            </div>
            <div className="bg-bg p-5">
              <label className="text-xs text-text-tertiary block mb-2">Chain</label>
              <span className="font-mono text-sm text-text-secondary">
                {chainId ? CHAIN_NAMES[chainId] || `Chain ${chainId}` : "\u2014"}
              </span>
            </div>
            <div className="bg-bg p-5">
              <label className="text-xs text-text-tertiary block mb-2">Workspace</label>
              <span className="font-mono text-sm text-text-secondary">
                {tenant?.tenantName || "\u2014"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Connection */}
      <div className="space-y-4">
        <h2 className="font-display text-sm font-600 text-text-secondary tracking-wider uppercase">
          API Connection
        </h2>
        <div className="space-y-px bg-border">
          <div className="bg-bg p-5">
            <label className="text-xs text-text-tertiary block mb-2">API Endpoint</label>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm text-text-secondary truncate">{API_URL}</span>
              <CopyButton text={API_URL} />
            </div>
          </div>
          <div className="bg-bg p-5">
            <label className="text-xs text-text-tertiary block mb-2">Tenant ID</label>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm text-text-secondary truncate">{TENANT_ID}</span>
              <CopyButton text={TENANT_ID} />
            </div>
          </div>
          {API_KEY && (
            <div className="bg-bg p-5">
              <label className="text-xs text-text-tertiary block mb-2">API Key</label>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm text-text-secondary truncate">
                  {showKey ? API_KEY : `${API_KEY.slice(0, 8)}${"•".repeat(32)}`}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    {showKey ? "Hide" : "Reveal"}
                  </button>
                  <CopyButton text={API_KEY} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Webhook */}
      <form onSubmit={saveWebhook} className="space-y-4">
        <h2 className="font-display text-sm font-600 text-text-secondary tracking-wider uppercase">
          Webhooks
        </h2>
        <p className="text-xs text-text-tertiary max-w-lg">
          Receive POST requests when transactions need approval or change status. Events include:
          approval_required, tx_signed, tx_confirmed, tx_failed.
        </p>
        <div>
          <label className="text-xs text-text-tertiary block mb-1.5">Webhook URL</label>
          <input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your-app.com/steward-webhook"
            className="w-full max-w-lg bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors disabled:opacity-40 font-medium"
          >
            {saving ? "Saving..." : "Save Webhook"}
          </button>
          {saved && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-xs text-emerald-400"
            >
              Saved
            </motion.span>
          )}
        </div>
      </form>

      {/* SDK Quick Start */}
      <div className="space-y-4">
        <h2 className="font-display text-sm font-600 text-text-secondary tracking-wider uppercase">
          SDK Quick Start
        </h2>
        <p className="text-xs text-text-tertiary max-w-lg">
          Install the SDK and start managing agent wallets in minutes.
        </p>
        <div className="border border-border bg-bg-elevated max-w-3xl">
          <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between">
            <span className="text-xs text-text-tertiary font-mono">npm i @stwd/sdk</span>
            <CopyButton text="npm i @stwd/sdk" />
          </div>
        </div>
        <div className="border border-border bg-bg-elevated max-w-3xl">
          <CodeBlock filename="example.ts" language="typescript" code={sdkSnippet} />
        </div>
      </div>
    </motion.div>
  );
}
