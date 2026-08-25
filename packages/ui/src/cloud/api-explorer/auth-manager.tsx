/**
 * Auth manager for the API Explorer: displays the auto-minted explorer key with
 * a visibility toggle, copy, and an override field for a custom key.
 * The "API calls are billed" notice is kept — explorer calls hit real billed
 * endpoints.
 */

import { Check, Copy, Eye, EyeOff, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { copyApiKeyToClipboard } from "../api-keys/copy-api-key";
import { toast } from "./toast";
import type { ExplorerApiKey } from "./use-explorer-api-key";

function useCopyFeedback(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false);
  const markCopied = useCallback(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), timeoutMs);
  }, [timeoutMs]);
  return { copied, markCopied };
}

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
  const { copied, markCopied } = useCopyFeedback();

  const handleCopy = async () => {
    try {
      await copyApiKeyToClipboard(authToken);
      markCopied();
      toast({ message: "API key copied", mode: "success" });
    } catch (err) {
      toast({
        message: err instanceof Error ? err.message : "Failed to copy API key",
        mode: "error",
      });
    }
  };

  const isValidKey =
    authToken &&
    (authToken.startsWith("eliza_") || authToken.startsWith("sk-"));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-neutral-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-neutral-400">{error}</p>
        {error.includes("sign in") && (
          <p className="text-xs text-neutral-500">
            Sign in to get an API key for testing.
          </p>
        )}
        <Button
          variant="ghostMuted"
          type="button"
          onClick={() => void onRefresh()}
        >
          <RefreshCw className="size-4" />
          Retry
        </Button>
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
          <label
            htmlFor="auth-manager-api-key"
            className="text-sm font-medium text-white"
          >
            API Key
          </label>
          <span className="text-xs text-neutral-400">
            Used {explorerKey.usage_count} times
          </span>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              variant="secret"
              id="auth-manager-api-key"
              type={showToken ? "text" : "password"}
              value={authToken}
              readOnly
            />
            <Button
              variant="ghostMuted"
              size="icon"
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-0 top-0"
            >
              {showToken ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
          <Button
            variant="outlineMuted"
            size="icon"
            type="button"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="size-4 text-status-success" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Billed-calls notice */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-sm bg-muted border border-border">
        <span className="text-xs text-muted">
          API calls are billed to your account
        </span>
      </div>

      {/* Custom key option */}
      {isValidKey && (
        <details className="text-xs">
          <summary className="text-neutral-400 cursor-pointer hover:text-white transition-colors">
            Use a different key
          </summary>
          <div className="mt-3 space-y-3">
            <Input
              variant="config"
              density="compact"
              type="text"
              placeholder="Enter custom API key…"
              onChange={(e) => onTokenChange(e.target.value)}
            />
            <Button
              variant="mutedLink"
              type="button"
              onClick={() => void onRefresh()}
            >
              Reset to default
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
