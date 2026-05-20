"use client";

import { cn } from "@feed/shared";
import { AlertCircle, Bot, Check, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";

/**
 * AI model info structure.
 */
interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

/**
 * AI models data structure from API.
 */
interface AIModelsData {
  providers: {
    groq: boolean;
    claude: boolean;
    openai: boolean;
  };
  activeProvider: "groq" | "claude" | "openai";
  recommendedModels: ModelInfo[];
}

/**
 * AI models tab component for managing AI model settings.
 *
 * Provides interface for viewing AI provider status.
 * Includes model testing functionality and provider status display.
 *
 * Features:
 * - Provider status display
 * - Model testing
 * - Recommended models display
 * - Loading states
 * - Error handling
 *
 * @returns AI models tab element
 */
export function AIModelsTab() {
  const [data, setData] = useState<AIModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(
    null,
  );

  const fetchData = useCallback(async () => {
    const token = getAuthToken();
    if (!token) {
      toast.error("Not authenticated");
      setLoading(false);
      return;
    }

    const response = await fetch(apiUrl("/api/admin/ai-models"), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      toast.error("Failed to load AI models");
      setLoading(false);
      return;
    }

    const result = await response.json();
    setData(result.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const token = getAuthToken();
    if (!token) {
      toast.error("Not authenticated");
      setTesting(false);
      return;
    }

    const response = await fetch(apiUrl("/api/admin/ai-models/test"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const result = await response.json();

    if (response.ok) {
      setTestResult(result.data);
    } else {
      toast.error(result.error || "Test failed");
      setTestResult({ error: result.error, details: result.details });
    }
    setTesting(false);
  };

  const getProviderIcon = (provider: string) => {
    switch (provider) {
      case "groq":
        return <Zap className="h-4 w-4" />;
      case "claude":
        return <Bot className="h-4 w-4" />;
      case "openai":
        return <Bot className="h-4 w-4" />;
      default:
        return <Bot className="h-4 w-4" />;
    }
  };

  const getProviderName = (provider: string) => {
    switch (provider) {
      case "groq":
        return "Groq";
      case "claude":
        return "Claude (Anthropic)";
      case "openai":
        return "OpenAI";
      default:
        return provider;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-primary border-b-2" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        Failed to load AI models configuration
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-2xl">AI Model Configuration</h2>
          <p className="mt-1 text-muted-foreground">
            View AI provider status for agent decision making
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="rounded-lg p-2 transition-colors hover:bg-accent"
        >
          <RefreshCw className={cn("h-5 w-5", loading && "animate-spin")} />
        </button>
      </div>

      {/* Current Provider Status */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
          {getProviderIcon(data.activeProvider)}
          Active Provider
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            <span className="font-medium">
              {getProviderName(data.activeProvider)}
            </span>
          </div>
        </div>
      </div>

      {/* Available Providers */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Available Providers</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {Object.entries(data.providers).map(([provider, available]) => (
            <div
              key={provider}
              className={cn(
                "rounded-lg border p-4 transition-colors",
                available
                  ? "border-green-500/30 bg-green-500/5"
                  : "border-border bg-muted/20",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {getProviderIcon(provider)}
                  <span className="font-medium">
                    {getProviderName(provider)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {available ? (
                    <>
                      <Check className="h-4 w-4 text-green-500" />
                      <span className="text-green-500 text-sm">Available</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground text-sm">
                      Not configured
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recommended Models */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <h3 className="mb-4 font-semibold text-lg">Recommended Models</h3>
        <div className="grid grid-cols-1 gap-2">
          {data.recommendedModels.map((model) => (
            <div key={model.id} className="rounded-lg border border-border p-4">
              <div className="mb-1 font-medium">{model.name}</div>
              <div className="text-muted-foreground text-sm">
                {model.description}
              </div>
              <div className="mt-2 font-mono text-muted-foreground text-xs">
                {model.id}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Setup Instructions for Missing Providers */}
      {!data.providers.groq && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-6">
          <div className="flex gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-500" />
            <div className="text-sm">
              <p className="mb-2 font-medium text-yellow-200">
                Groq Not Configured
              </p>
              <p className="mb-3 text-yellow-200/80">
                To use Groq models (recommended), add your API key to the
                environment:
              </p>
              <code className="block rounded bg-black/30 p-3 font-mono text-xs text-yellow-100">
                GROQ_API_KEY=your_api_key_here
              </code>
              <p className="mt-3 text-yellow-200/80">
                Get your API key from:{" "}
                <a
                  href="https://console.groq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-yellow-400 hover:underline"
                >
                  https://console.groq.com
                </a>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Test Result */}
      {testResult && (
        <div
          className={cn(
            "rounded-lg border p-6",
            testResult.error
              ? "border-red-500/20 bg-red-500/10"
              : "border-green-500/20 bg-green-500/10",
          )}
        >
          <h3 className="mb-3 font-semibold text-lg">
            {testResult.error ? "❌ Test Failed" : "✅ Test Successful"}
          </h3>
          {!testResult.error ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Provider:</span>
                <span className="font-medium font-mono">
                  {String(testResult.provider || "unknown")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Model:</span>
                <span className="font-medium font-mono">
                  {String(testResult.model || "unknown")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Latency:</span>
                <span className="font-medium font-mono">
                  {String(testResult.latency || 0)}ms
                </span>
              </div>
              <div className="mt-3 rounded bg-black/20 p-3">
                <div className="mb-1 text-muted-foreground">Response:</div>
                <div className="font-mono text-sm">
                  {JSON.stringify(testResult.response, null, 2)}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="text-red-200">
                {String(testResult.error || "Unknown error")}
              </div>
              {testResult.details !== undefined &&
                testResult.details !== null && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-red-200/80">
                      Error Details
                    </summary>
                    <pre className="mt-2 overflow-auto rounded bg-black/20 p-3 text-xs">
                      {String(testResult.details)}
                    </pre>
                  </details>
                )}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-4 border-border border-t pt-4">
        <button
          onClick={handleTest}
          disabled={testing}
          className={cn(
            "rounded-lg px-6 py-2 font-medium transition-all",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {testing ? (
            <span className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Testing...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Test Current Configuration
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
