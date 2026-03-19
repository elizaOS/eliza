import { Button, Input } from "@miladyai/ui";
import { useCallback, useRef, useState } from "react";
import { client } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { getProviderLogo } from "../../providers";
import { useApp } from "../../state";

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

interface ProviderDropdownProps {
  pluginId: string;
  pluginName: string;
  enabled: boolean;
  configured: boolean;
  detected?: { source: string } | null;
  onClose: () => void;
}

export function ProviderDropdown({
  pluginId,
  pluginName,
  enabled,
  configured,
  detected,
  onClose,
}: ProviderDropdownProps) {
  const { uiTheme } = useApp();
  const isDark = uiTheme !== "light";
  const normalizedId = normalizeAiProviderPluginId(pluginId);
  const logo = getProviderLogo(normalizedId, isDark);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [saveResult, setSaveResult] = useState<"ok" | "fail" | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(dropdownRef, onClose);

  const statusColor = enabled
    ? "bg-ok"
    : configured
      ? "bg-muted"
      : "bg-danger";
  const statusLabel = enabled
    ? "Active"
    : configured
      ? "Configured"
      : "Not configured";

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await client.switchProvider(normalizedId, apiKey.trim());
      setSaveResult("ok");
      setApiKey("");
    } catch {
      setSaveResult("fail");
    } finally {
      setSaving(false);
    }
  }, [apiKey, normalizedId]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await client.fetchModels(normalizedId);
      setTestResult(res.models?.length ? "ok" : "fail");
    } catch {
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  }, [normalizedId]);

  return (
    <div
      ref={dropdownRef}
      data-testid="provider-dropdown"
      className="absolute top-full left-0 z-50 mt-1 w-[320px] rounded-lg border border-border bg-bg shadow-xl p-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <img src={logo} alt={pluginName} className="w-5 h-5 rounded" />
          <span className="text-sm font-semibold text-txt">{pluginName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-[11px] text-muted">{statusLabel}</span>
        </div>
      </div>

      <div className="border-t border-border/50 my-2" />

      {/* API key input */}
      <label
        htmlFor={`milady-bar-apikey-${pluginId}`}
        className="block text-[11px] text-muted mb-1"
      >
        API Key
      </label>
      <Input
        id={`milady-bar-apikey-${pluginId}`}
        type="password"
        placeholder="sk-•••••••••"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className="bg-card text-[13px] mb-2"
        data-testid="provider-api-key-input"
      />

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={saving || !apiKey.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? "Testing…" : "Test"}
        </Button>
        {saveResult === "ok" && (
          <span className="text-[11px] text-ok">Saved</span>
        )}
        {saveResult === "fail" && (
          <span className="text-[11px] text-danger">Save failed</span>
        )}
        {testResult === "ok" && (
          <span className="text-[11px] text-ok">Connected</span>
        )}
        {testResult === "fail" && (
          <span className="text-[11px] text-danger">Failed</span>
        )}
      </div>

      {/* Detected source badge */}
      {detected && (
        <>
          <div className="border-t border-border/50 my-2" />
          <span className="text-[11px] text-muted">
            Detected from{" "}
            <span className="font-medium text-txt">{detected.source}</span>
          </span>
        </>
      )}
    </div>
  );
}
