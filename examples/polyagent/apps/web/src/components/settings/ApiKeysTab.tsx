"use client";

import { logger } from "@polyagent/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Key,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

interface ApiKey {
  id: string;
  name: string | null;
  maskedKey: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface ApiKeyResponse {
  id: string;
  apiKey: string;
  name: string | null;
  createdAt: string;
  message: string;
}

/**
 * API Keys tab component for managing user API keys.
 *
 * Allows users to generate, view (masked), and revoke API keys for MCP authentication.
 * Shows security warnings and usage instructions.
 *
 * @returns API Keys tab element
 */
export function ApiKeysTab() {
  const { getAccessToken } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [newKey, setNewKey] = useState<ApiKeyResponse | null>(null);
  const [keyName, setKeyName] = useState("");

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    const token = await getAccessToken();
    if (!token) {
      logger.error("Not authenticated", undefined, "ApiKeysTab");
      toast.error("Failed to load API keys");
      setLoading(false);
      return;
    }

    const response = await fetch("/api/users/api-keys", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.error(
        "Failed to fetch API keys",
        { status: response.status },
        "ApiKeysTab",
      );
      toast.error("Failed to load API keys");
      setLoading(false);
      return;
    }

    const data = await response.json();
    setKeys(data.keys || []);
    setLoading(false);
  }, [getAccessToken]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleGenerateKey = async () => {
    setGenerating(true);
    const token = await getAccessToken();
    if (!token) {
      logger.error("Not authenticated", undefined, "ApiKeysTab");
      toast.error("Failed to generate API key");
      setGenerating(false);
      return;
    }

    const response = await fetch("/api/users/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: keyName || undefined }),
    });

    if (!response.ok) {
      const error = await response.json();
      const errorMessage = error.error || "Failed to generate API key";
      logger.error(
        "Failed to generate API key",
        { status: response.status, error: errorMessage },
        "ApiKeysTab",
      );
      toast.error(errorMessage);
      setGenerating(false);
      return;
    }

    const data: ApiKeyResponse = await response.json();
    setNewKey(data);
    setKeyName("");
    await fetchKeys();
    toast.success("API key generated successfully");
    setGenerating(false);
  };

  const handleRevokeKey = async (keyId: string) => {
    if (
      !confirm(
        "Are you sure you want to revoke this API key? This action cannot be undone and any applications using this key will stop working.",
      )
    ) {
      return;
    }

    const token = await getAccessToken();
    if (!token) {
      logger.error("Not authenticated", undefined, "ApiKeysTab");
      toast.error("Failed to revoke API key");
      return;
    }

    const response = await fetch(`/api/users/api-keys/${keyId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      logger.error(
        "Failed to revoke API key",
        { status: response.status },
        "ApiKeysTab",
      );
      toast.error("Failed to revoke API key");
      return;
    }

    toast.success("API key revoked successfully");
    await fetchKeys();
  };

  const handleCopyKey = async (key: string) => {
    await navigator.clipboard.writeText(key);
    toast.success("API key copied to clipboard");
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 font-bold text-2xl">
          <Key className="h-6 w-6 text-[#0066FF]" />
          API Keys
        </h2>
        <p className="text-muted-foreground text-sm">
          Generate and manage API keys for MCP authentication. Use these keys to
          connect external AI agents (Cursor, Claude, OpenAI) to your Polyagent
          account.
        </p>
      </div>

      {/* Security Warning */}
      <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-yellow-500" />
          <div className="space-y-1">
            <p className="font-semibold text-sm text-yellow-500">
              Keep your API keys secure
            </p>
            <p className="text-sm text-yellow-500/90">
              API keys provide full access to your account. Never share them or
              commit them to version control. If a key is compromised, revoke it
              immediately.
            </p>
          </div>
        </div>
      </div>

      {/* New Key Display (shown once after generation) */}
      {newKey && (
        <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-semibold text-green-500 text-sm">
                API Key Generated
              </p>
              <p className="text-green-500/90 text-sm">
                {newKey.message} Copy and save this key now - you won't be able
                to see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background px-3 py-2 font-mono text-sm">
                  {newKey.apiKey}
                </code>
                <button
                  onClick={() => handleCopyKey(newKey.apiKey)}
                  className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 transition-colors hover:bg-muted"
                  title="Copy API key"
                >
                  <Copy className="h-4 w-4" />
                  <span className="text-sm">Copy</span>
                </button>
              </div>
            </div>
            <button
              onClick={() => setNewKey(null)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Generate New Key */}
      <div className="rounded-lg border border-border bg-muted/50 p-4">
        <h3 className="mb-3 font-semibold">Generate New API Key</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="Optional: Name for this key (e.g., 'Cursor Desktop')"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0066FF]"
          />
          <button
            onClick={handleGenerateKey}
            disabled={generating}
            className="flex items-center gap-2 rounded-lg bg-[#0066FF] px-4 py-2 font-medium text-white transition-colors hover:bg-[#2952d9] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            <span>{generating ? "Generating..." : "Generate Key"}</span>
          </button>
        </div>
      </div>

      {/* Existing Keys */}
      <div className="space-y-4">
        <h3 className="font-semibold">Your API Keys</h3>
        {loading ? (
          <div className="rounded-lg border border-border p-4 text-center text-muted-foreground">
            Loading API keys...
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-lg border border-border p-8 text-center">
            <Key className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
            <p className="mb-1 font-medium">No API keys yet</p>
            <p className="text-muted-foreground text-sm">
              Generate your first API key to start using MCP with external AI
              agents.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-lg border border-border bg-background p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  {key.name && (
                    <p className="font-semibold text-sm">{key.name}</p>
                  )}
                  <code className="block font-mono text-sm">
                    {key.maskedKey}
                  </code>
                  <div className="flex gap-4 text-muted-foreground text-xs">
                    <span>Created: {formatDate(key.createdAt)}</span>
                    {key.lastUsedAt && (
                      <span>Last used: {formatDate(key.lastUsedAt)}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeKey(key.id)}
                  className="flex items-center gap-2 rounded-lg border border-destructive/50 px-3 py-2 text-destructive transition-colors hover:bg-destructive/10"
                  title="Revoke API key"
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="text-sm">Revoke</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Usage Instructions */}
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <h3 className="mb-2 font-semibold text-sm">How to Use API Keys</h3>
        <div className="space-y-2 text-muted-foreground text-sm">
          <p>1. Generate an API key and copy it to a secure location</p>
          <p>
            2. Add the key to your AI agent configuration (Cursor, Claude
            Desktop, etc.)
          </p>
          <p>
            3. Use the key in the{" "}
            <code className="rounded bg-background px-1">
              X-Polyagent-Api-Key
            </code>{" "}
            header when making MCP requests
          </p>
          <p>
            4. Your agent will be able to control your account and create/manage
            agents on your behalf
          </p>
        </div>
      </div>
    </div>
  );
}
