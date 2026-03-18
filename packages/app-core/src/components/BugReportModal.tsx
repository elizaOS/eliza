import { Input } from "@elizaos/ui";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import { useBranding } from "../config/branding";
import { useBugReport, useTimeout } from "../hooks";
import { useApp } from "../state";
import { openExternalUrl } from "../utils";

const ENV_OPTIONS = ["macOS", "Windows", "Linux", "Other"] as const;

interface BugReportForm {
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  environment: string;
  nodeVersion: string;
  modelProvider: string;
  logs: string;
}

const EMPTY_FORM: BugReportForm = {
  description: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  environment: "",
  nodeVersion: "",
  modelProvider: "",
  logs: "",
};

export function BugReportModal() {
  const { setTimeout } = useTimeout();

  const { copyToClipboard, t } = useApp();
  const branding = useBranding();
  const { isOpen, close } = useBugReport();
  const [form, setForm] = useState<BugReportForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Fetch env info on open with cancellation guard
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    setForm(EMPTY_FORM);
    setSubmitting(false);
    setResultUrl(null);
    setErrorMsg(null);
    setShowLogs(false);
    setCopied(false);

    client
      .checkBugReportInfo()
      .then((info) => {
        if (cancelled) return;
        if (info.nodeVersion)
          setForm((f) => ({ ...f, nodeVersion: info.nodeVersion ?? "" }));
        if (info.platform)
          setForm((f) => ({
            ...f,
            environment:
              info.platform === "darwin"
                ? "macOS"
                : info.platform === "win32"
                  ? "Windows"
                  : info.platform === "linux"
                    ? "Linux"
                    : "Other",
          }));
      })
      .catch(() => {});
    setTimeout(() => descRef.current?.focus(), 50);

    return () => {
      cancelled = true;
    };
  }, [isOpen, setTimeout]);

  const updateField = useCallback(
    <K extends keyof BugReportForm>(key: K, value: BugReportForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  const formatMarkdown = useCallback((): string => {
    const strip = (s: string, max = 10_000) =>
      s.replace(/<[^>]*>/g, "").slice(0, max);
    const lines: string[] = [];
    lines.push(`### Description\n${strip(form.description)}`);
    lines.push(`\n### Steps to Reproduce\n${strip(form.stepsToReproduce)}`);
    if (form.expectedBehavior)
      lines.push(`\n### Expected Behavior\n${strip(form.expectedBehavior)}`);
    if (form.actualBehavior)
      lines.push(`\n### Actual Behavior\n${strip(form.actualBehavior)}`);
    lines.push(
      `\n### Environment\n${strip(form.environment || "Not specified", 200)}`,
    );
    if (form.nodeVersion)
      lines.push(`\n### Node Version\n${strip(form.nodeVersion, 200)}`);
    if (form.modelProvider)
      lines.push(`\n### Model Provider\n${strip(form.modelProvider, 200)}`);
    if (form.logs)
      lines.push(`\n### Logs\n\`\`\`\n${strip(form.logs, 50_000)}\n\`\`\``);
    return lines.join("\n");
  }, [form]);

  const handleSubmit = useCallback(async () => {
    if (!form.description.trim() || !form.stepsToReproduce.trim()) {
      setErrorMsg("Description and Steps to Reproduce are required.");
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const result = await client.submitBugReport({
        description: form.description,
        stepsToReproduce: form.stepsToReproduce,
        expectedBehavior: form.expectedBehavior,
        actualBehavior: form.actualBehavior,
        environment: form.environment,
        nodeVersion: form.nodeVersion,
        modelProvider: form.modelProvider,
        logs: form.logs,
      });
      if (result.url) {
        setResultUrl(result.url);
      } else if (result.fallback) {
        // No GITHUB_TOKEN on server — copy report and open GitHub manually
        let ok = false;
        try {
          await copyToClipboard(formatMarkdown());
          ok = true;
        } catch {
          ok = false;
        }
        setCopied(ok);
        await openExternalUrl(result.fallback);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to submit bug report",
      );
    } finally {
      setSubmitting(false);
    }
  }, [copyToClipboard, form, formatMarkdown]);

  const handleCopyAndOpen = useCallback(async () => {
    let ok = false;
    try {
      await copyToClipboard(formatMarkdown());
      ok = true;
    } catch {
      ok = false;
    }
    setCopied(ok);
    await openExternalUrl(branding.bugReportUrl);
  }, [copyToClipboard, formatMarkdown, branding.bugReportUrl]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const labelClass = "block text-[11px] font-bold mb-1";
  const labelStyle = { color: "var(--muted)" };
  const inputClass =
    "w-full h-9 px-3 py-2 text-sm shadow-sm transition-colors font-body";
  const inputStyle = {
    background: "var(--bg-hover)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  };
  const textareaClass =
    "w-full px-3 py-2 text-sm shadow-sm focus-visible:ring-1 transition-colors font-body resize-y min-h-[60px]";
  const textareaStyle = {
    background: "var(--bg-hover)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  };
  const canSubmit =
    form.description.trim() && form.stepsToReproduce.trim() && !submitting;

  const backdropProps = {
    className: "fixed inset-0 z-50 flex items-center justify-center",
    style: {
      background: "color-mix(in srgb, var(--bg) 50%, transparent)",
      backdropFilter: "blur(4px)",
    } as React.CSSProperties,
    onClick: (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) close();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") close();
    },
    role: "dialog" as const,
    "aria-modal": true as const,
    tabIndex: -1,
  };

  // Success state
  if (resultUrl) {
    return (
      <div {...backdropProps}>
        <div
          className="w-full max-w-md shadow-lg flex flex-col rounded-xl"
          style={{
            background: "color-mix(in srgb, var(--bg) 96%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
            backdropFilter: "blur(24px)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div
            className="flex items-center px-5 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <span
              className="font-bold text-sm flex-1"
              style={{ color: "var(--text)" }}
            >
              {t("bugreportmodal.BugReportSubmitted")}
            </span>
            <button
              type="button"
              className="bg-transparent border-0 cursor-pointer text-lg h-6 w-6"
              style={{ color: "var(--muted)" }}
              onClick={close}
            >
              {t("bugreportmodal.Times")}
            </button>
          </div>
          <div className="px-5 py-6 text-center">
            <p className="text-sm mb-3" style={{ color: "var(--text)" }}>
              {t("bugreportmodal.YourBugReportHas")}
            </p>
            <a
              href={resultUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm hover:underline break-all"
              style={{ color: "#f0b232" }}
            >
              {resultUrl}
            </a>
          </div>
          <div
            className="flex justify-end px-5 py-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <button
              type="button"
              className="px-4 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors"
              style={{
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
              onClick={close}
            >
              {t("bugreportmodal.Close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div {...backdropProps}>
      <div
        className="w-full max-w-lg shadow-lg flex flex-col max-h-[85vh] rounded-xl"
        style={{
          background: "color-mix(in srgb, var(--bg) 96%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
          backdropFilter: "blur(24px)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center px-5 py-3 shrink-0"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <span
            className="font-bold text-sm flex-1"
            style={{ color: "var(--text)" }}
          >
            {t("bugreportmodal.ReportABug")}
          </span>
          <button
            type="button"
            className="bg-transparent border-0 cursor-pointer text-lg h-6 w-6"
            style={{ color: "var(--muted)" }}
            onClick={close}
          >
            {t("bugreportmodal.Times")}
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-3 overflow-y-auto">
          {errorMsg && (
            <div
              className="text-xs px-3 py-2"
              style={{ color: "#ef4444", border: "1px solid #ef4444" }}
            >
              {errorMsg}
            </div>
          )}

          <label className={labelClass} style={labelStyle}>
            {t("skillsview.Description")}{" "}
            <span style={{ color: "#ef4444" }}>*</span>
            <textarea
              ref={descRef}
              className={textareaClass}
              style={textareaStyle}
              placeholder={t("bugreportmodal.DescribeTheIssueY")}
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              rows={3}
            />
          </label>

          <label className={labelClass} style={labelStyle}>
            {t("bugreportmodal.StepsToReproduce")}{" "}
            <span style={{ color: "#ef4444" }}>*</span>
            <textarea
              className={textareaClass}
              style={textareaStyle}
              placeholder={"1. Go to ...\n2. Click on ...\n3. Observe ..."}
              value={form.stepsToReproduce}
              onChange={(e) => updateField("stepsToReproduce", e.target.value)}
              rows={3}
            />
          </label>

          <label className={labelClass} style={labelStyle}>
            {t("bugreportmodal.ExpectedBehavior")}
            <textarea
              className={textareaClass}
              style={textareaStyle}
              placeholder={t("bugreportmodal.DescribeTheExpecte")}
              value={form.expectedBehavior}
              onChange={(e) => updateField("expectedBehavior", e.target.value)}
              rows={2}
            />
          </label>

          <label className={labelClass} style={labelStyle}>
            {t("bugreportmodal.ActualBehavior")}
            <textarea
              className={textareaClass}
              style={textareaStyle}
              placeholder={t("bugreportmodal.DescribeTheActual")}
              value={form.actualBehavior}
              onChange={(e) => updateField("actualBehavior", e.target.value)}
              rows={2}
            />
          </label>

          <div className="flex gap-3">
            <label className={`${labelClass} flex-1`} style={labelStyle}>
              {t("bugreportmodal.Environment")}
              <select
                className={inputClass}
                style={inputStyle}
                value={form.environment}
                onChange={(e) => updateField("environment", e.target.value)}
              >
                <option value="">{t("bugreportmodal.Select")}</option>
                {ENV_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Custom <Input> component is inside <label> */}
            <label className={`${labelClass} flex-1`} style={labelStyle}>
              {t("bugreportmodal.NodeVersion")}
              <Input
                className={inputClass}
                style={inputStyle}
                placeholder={t("bugreportmodal.22X")}
                value={form.nodeVersion}
                onChange={(e) => updateField("nodeVersion", e.target.value)}
              />
            </label>
          </div>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: Custom <Input> component is inside <label> */}
          <label className={labelClass} style={labelStyle}>
            {t("bugreportmodal.ModelProvider")}
            <Input
              className={inputClass}
              style={inputStyle}
              placeholder={t("bugreportmodal.AnthropicOpenAI")}
              value={form.modelProvider}
              onChange={(e) => updateField("modelProvider", e.target.value)}
            />
          </label>

          {/* Collapsible Logs */}
          <div>
            <button
              type="button"
              className="h-auto p-0 text-[11px] font-bold bg-transparent border-0 cursor-pointer flex items-center gap-1 transition-colors"
              style={{ color: "var(--muted)" }}
              onClick={() => setShowLogs(!showLogs)}
            >
              <ChevronRight
                className="w-3 h-3 inline-block transition-transform"
                style={{ transform: showLogs ? "rotate(90deg)" : "none" }}
              />

              {t("bugreportmodal.Logs")}
            </button>
            {showLogs && (
              <textarea
                className={`${textareaClass} mt-1 font-mono text-xs`}
                style={textareaStyle}
                placeholder={t("bugreportmodal.PasteRelevantError")}
                value={form.logs}
                onChange={(e) => updateField("logs", e.target.value)}
                rows={4}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2 px-5 py-3 shrink-0"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
            onClick={close}
          >
            {t("onboarding.cancel")}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors disabled:opacity-50"
              style={{
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
              onClick={handleCopyAndOpen}
              disabled={!canSubmit}
            >
              {copied ? "Copied!" : "Copy & Open GitHub"}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium rounded cursor-pointer transition-colors disabled:opacity-50"
              style={{ background: "#f0b232", border: "none", color: "#000" }}
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
