/**
 * Auth manager component for API explorer authentication.
 * Manages API key display, creation, and validation with visibility toggle.
 */

"use client";

import { Check, Copy, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { copyApiKeyToClipboard } from "@/lib/client/api-keys";
import { COPY_FEEDBACK_DURATION_MS } from "@/lib/constants/copy-feedback";
import { toast } from "@/lib/utils/toast-adapter";
import type { ExplorerApiKey } from "./use-explorer-api-key";

interface AuthManagerProps {
  authToken: string;
  explorerKey: ExplorerApiKey | null;
  isLoading: boolean;
  error: string | null;
  onTokenChange: (token: string) => void;
  onRefresh: () => Promise<void>;
}

export function AuthManager({
  authToken,
  explorerKey,
  isLoading,
  error,
  onTokenChange,
  onRefresh,
}: AuthManagerProps) {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyApiKeyToClipboard(authToken);
      setCopied(true);
      toast({ message: "API key copied", mode: "success" });
      setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : "Failed to copy API key",
        mode: "error",
      });
    }
  };

  const isValidKey = authToken && (authToken.startsWith("eliza_") || authToken.startsWith("sk-"));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-neutral-400">{error}</p>
        {error.includes("sign in") && (
          <p className="text-xs text-neutral-500">Sign in to get an API key for testing.</p>
        )}
        <button
          onClick={() => void onRefresh()}
          className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  if (!explorerKey) {
    return (
      <p className="text-sm text-neutral-500">
        No API key available. Please sign in to test endpoints.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Key input */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-white">API Key</label>
          <span className="text-xs text-neutral-400">Used {explorerKey.usage_count} times</span>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showToken ? "text" : "password"}
              value={authToken}
              readOnly
              className="w-full h-10 px-3 pr-10 rounded-lg border border-white/10 bg-black/40 text-white font-mono text-sm focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-0 top-0 h-full px-3 text-neutral-500 hover:text-white transition-colors"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            onClick={handleCopy}
            className="h-10 px-3 rounded-lg border border-white/10 bg-black/40 text-neutral-400 hover:text-white transition-colors"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Notice */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
        <span className="text-xs text-amber-400">API calls are billed to your account</span>
      </div>

      {/* Custom key option */}
      {isValidKey && (
        <details className="text-xs">
          <summary className="text-neutral-400 cursor-pointer hover:text-white transition-colors">
            Use a different key
          </summary>
          <div className="mt-3 space-y-3">
            <input
              type="text"
              placeholder="Enter custom API key..."
              onChange={(e) => onTokenChange(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-white/10 bg-black/40 text-white text-sm placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-[#FF5800]/50"
            />
            <button
              onClick={() => void onRefresh()}
              className="text-neutral-400 hover:text-white transition-colors"
            >
              Reset to default
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
