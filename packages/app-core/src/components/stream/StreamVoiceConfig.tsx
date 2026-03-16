/**
 * StreamVoiceConfig — compact voice config panel for StreamView.
 *
 * Shows a toggle to enable/disable TTS on the RTMP stream, detected
 * provider + API key status, and a test button to speak sample text.
 */

import { client } from "@elizaos/app-core/api";
import { useTimeout } from "@elizaos/app-core/hooks";
import { useApp } from "@elizaos/app-core/state";
import { Button } from "@elizaos/ui";
import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface VoiceStatus {
  enabled: boolean;
  autoSpeak: boolean;
  provider: string | null;
  configuredProvider: string | null;
  hasApiKey: boolean;
  isSpeaking: boolean;
  isAttached: boolean;
}

export function StreamVoiceConfig({ streamLive }: { streamLive: boolean }) {
  const { setTimeout } = useTimeout();

  const { t } = useApp();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // Poll voice status
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await client.getStreamVoice();
        if (mounted && res.ok) {
          setStatus(res);
          setSpeaking(res.isSpeaking);
        }
      } catch {
        // API may not be available yet
      }
    };
    poll();
    const id = setInterval(poll, 5_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const toggleEnabled = useCallback(async () => {
    if (!status || loading) return;
    setLoading(true);
    try {
      const next = !status.enabled;
      const res = await client.saveStreamVoice({ enabled: next });
      if (res.ok) {
        setStatus((prev) =>
          prev ? { ...prev, enabled: res.voice.enabled } : prev,
        );
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [status, loading]);

  const testSpeak = useCallback(async () => {
    if (speaking) return;
    setSpeaking(true);
    try {
      await client.streamVoiceSpeak("Hello, I am now speaking on the stream.");
    } catch {
      // Ignore
    } finally {
      // Poll will update speaking state
      setTimeout(() => setSpeaking(false), 3000);
    }
  }, [
    speaking, // Poll will update speaking state
    setTimeout,
  ]);

  if (!status) return null;

  const providerLabel = status.provider
    ? status.provider.charAt(0).toUpperCase() + status.provider.slice(1)
    : "None";

  return (
    <div className="flex items-center gap-2 text-xs">
      {/* Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleEnabled}
        disabled={loading}
        className={`flex items-center gap-1.5 px-2 py-1 h-7 rounded text-xs font-medium transition-colors ${
          status.enabled
            ? "bg-accent/20 text-txt hover:bg-accent/30"
            : "bg-surface text-muted hover:bg-surface-hover"
        }`}
        title={
          status.enabled
            ? "Voice on stream: ON (click to disable)"
            : "Voice on stream: OFF (click to enable)"
        }
      >
        {status.enabled ? (
          <Volume2 className="w-3.5 h-3.5" />
        ) : (
          <VolumeX className="w-3.5 h-3.5" />
        )}
        <span>{t("streamvoiceconfig.Voice")}</span>
      </Button>

      {/* Status indicators (when enabled) */}
      {status.enabled && (
        <>
          <span className="text-muted">
            {providerLabel}
            {!status.hasApiKey && status.provider !== "edge" && (
              <span
                className="text-warning ml-1"
                title={t("streamvoiceconfig.NoAPIKeyConfigure")}
              >
                {t("streamvoiceconfig.NoKey")}
              </span>
            )}
          </span>

          {speaking && (
            <span className="text-txt animate-pulse">
              {t("streamvoiceconfig.Speaking")}
            </span>
          )}

          {/* Test button — only when stream is live and bridge attached */}
          {streamLive && status.isAttached && (
            <Button
              variant="ghost"
              size="sm"
              onClick={testSpeak}
              disabled={speaking}
              className="px-1.5 py-0.5 h-6 rounded bg-surface text-muted hover:bg-surface-hover hover:text-txt text-[10px] transition-colors"
              title={t("streamvoiceconfig.TestTTSOnStream")}
            >
              {t("streamvoiceconfig.Test")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
