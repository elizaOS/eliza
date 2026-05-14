import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import { isElectrobunRuntime } from "../../bridge";
import { useBranding } from "../../config/branding";
import { useBugReport } from "../../hooks";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import {
  createDesktopBugReportBundle,
  type DesktopBugReportDiagnostics,
  formatDesktopBugReportDiagnostics,
  loadDesktopBugReportDiagnostics,
  openDesktopLogsFolder,
} from "../../utils/desktop-bug-report";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldMessage } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

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

const modalContentClassName =
  "w-[min(calc(100%_-_2rem),42rem)] max-h-[min(88vh,52rem)] overflow-hidden rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl backdrop-blur-xl";

const modalInputClassName =
  "h-11 rounded-xl border-border bg-bg-hover text-txt placeholder:text-muted/70 focus-visible:ring-accent/30";

const modalTextareaClassName =
  "min-h-[88px] rounded-xl border-border bg-bg-hover px-4 py-3 text-sm text-txt placeholder:text-muted/70 focus-visible:ring-accent/30";

const subtleMonoDescriptionClassName = "font-mono text-xs-tight text-muted";

function environmentOptionLabel(
  t: ReturnType<typeof useApp>["t"],
  option: (typeof ENV_OPTIONS)[number],
): string {
  if (option === "Other") {
    return t("bugreportmodal.Other", { defaultValue: "Other" });
  }
  return option;
}

function normalizeHttpsResultUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function BugReportModal() {
  const { copyToClipboard, t } = useApp();
  const desktopRuntime = isElectrobunRuntime();
  const branding = useBranding();
  const { isOpen, draft, close } = useBugReport();
  const [form, setForm] = useState<BugReportForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [acceptedWithoutUrl, setAcceptedWithoutUrl] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const [desktopDiagnostics, setDesktopDiagnostics] =
    useState<DesktopBugReportDiagnostics | null>(null);
  const [attachLogs, setAttachLogs] = useState(true);
  const [attachSystemInfo, setAttachSystemInfo] = useState(true);
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [savingBundle, setSavingBundle] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  // Fetch env info on open with cancellation guard
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    setForm(EMPTY_FORM);
    setSubmitting(false);
    setResultUrl(null);
    setAcceptedWithoutUrl(false);
    setErrorMsg(null);
    setShowLogs(false);
    setCopied(false);
    setCopiedDiagnostics(false);
    setDesktopDiagnostics(null);
    setAttachLogs(true);
    setAttachSystemInfo(true);
    setBundlePath(null);
    setSavingBundle(false);

    client
      .checkBugReportInfo()
      .then((info) => {
        if (cancelled) return;
        setForm((f) => ({
          ...f,
          ...(info.nodeVersion ? { nodeVersion: info.nodeVersion ?? "" } : {}),
          ...(info.platform
            ? {
                environment:
                  info.platform === "darwin"
                    ? "macOS"
                    : info.platform === "win32"
                      ? "Windows"
                      : info.platform === "linux"
                        ? "Linux"
                        : "Other",
              }
            : {}),
        }));
      })
      .catch((err: unknown) => {
        console.warn("[BugReportModal] Failed to fetch bug report info:", err);
      });
    if (desktopRuntime) {
      loadDesktopBugReportDiagnostics()
        .then((diagnostics) => {
          if (cancelled || !diagnostics) return;
          setDesktopDiagnostics(diagnostics);
          if (diagnostics.platform === "win32") {
            setForm((f) => ({
              ...f,
              environment: f.environment || "Windows",
              logs: f.logs || diagnostics.logTail || "",
            }));
          } else {
            setForm((f) => ({
              ...f,
              logs: f.logs || diagnostics.logTail || "",
            }));
          }
        })
        .catch((err: unknown) => {
          console.warn(
            "[BugReportModal] Failed to fetch desktop diagnostics:",
            err,
          );
        });
    }
    setTimeout(() => descRef.current?.focus(), 50);

    return () => {
      cancelled = true;
    };
  }, [desktopRuntime, isOpen]);
  useEffect(() => {
    if (!isOpen || !draft) return;
    setForm((f) => ({
      ...f,
      ...draft,
    }));
  }, [draft, isOpen]);

  useEffect(() => {
    if (!resultUrl) return;
    successHeadingRef.current?.focus();
  }, [resultUrl]);

  const updateField = useCallback(
    <K extends keyof BugReportForm>(key: K, value: BugReportForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  const buildDiagnosticsBlock = useCallback((): string => {
    if (!desktopDiagnostics) return "";
    const sections: string[] = [];
    if (attachSystemInfo) {
      sections.push(formatDesktopBugReportDiagnostics(desktopDiagnostics));
    }
    if (attachLogs && desktopDiagnostics.logTail) {
      sections.push(`Startup Log Tail\n${desktopDiagnostics.logTail}`);
    }
    return sections.join("\n\n");
  }, [attachLogs, attachSystemInfo, desktopDiagnostics]);

  const buildCombinedLogs = useCallback((): string => {
    const sections = [form.logs.trim(), buildDiagnosticsBlock().trim()].filter(
      Boolean,
    );
    return sections.join("\n\n");
  }, [buildDiagnosticsBlock, form.logs]);

  const formatMarkdown = useCallback((): string => {
    const strip = (s: string, max = 10_000) => {
      const truncated = s.length > max ? s.slice(0, max) : s;
      // Iteratively strip `<...>` tags to defeat embedded `<scr<script>ipt>` patterns.
      let out = truncated;
      let prev: string;
      do {
        prev = out;
        out = out.replace(/<[^>]*>/g, "");
      } while (out !== prev);
      return out.slice(0, max);
    };
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
    const combinedLogs = buildCombinedLogs();
    if (combinedLogs) {
      lines.push(`\n### Logs\n\`\`\`\n${strip(combinedLogs, 50_000)}\n\`\`\``);
    }
    return lines.join("\n");
  }, [buildCombinedLogs, form]);

  const buildReportPayload = useCallback(
    () => ({
      description: form.description,
      stepsToReproduce: form.stepsToReproduce,
      expectedBehavior: form.expectedBehavior,
      actualBehavior: form.actualBehavior,
      environment: form.environment,
      nodeVersion: form.nodeVersion,
      modelProvider: form.modelProvider,
      attachLogs,
      attachSystemInfo,
      desktopDiagnostics: desktopDiagnostics
        ? {
            ...desktopDiagnostics,
            logTail: attachLogs ? desktopDiagnostics.logTail : "",
          }
        : null,
    }),
    [attachLogs, attachSystemInfo, desktopDiagnostics, form],
  );

  const handleSubmit = useCallback(async () => {
    if (!form.description.trim() || !form.stepsToReproduce.trim()) {
      setErrorMsg(t("bugreportmodal.descriptionRequired"));
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
        logs: buildCombinedLogs(),
      });
      const safeResultUrl = normalizeHttpsResultUrl(result.url);
      if (safeResultUrl) {
        setResultUrl(safeResultUrl);
      } else if (result.accepted) {
        setAcceptedWithoutUrl(true);
      } else if (result.fallback) {
        // No GITHUB_TOKEN on server — copy report and open GitHub manually
        let ok = false;
        try {
          await copyToClipboard(formatMarkdown());
          ok = true;
        } catch (err) {
          console.warn(
            "[BugReportModal] Failed to copy bug report to clipboard:",
            err,
          );
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
  }, [buildCombinedLogs, copyToClipboard, form, formatMarkdown, t]);

  const handleCopyAndOpen = useCallback(async () => {
    let ok = false;
    try {
      await copyToClipboard(formatMarkdown());
      ok = true;
    } catch (err) {
      console.warn(
        "[BugReportModal] Failed to copy bug report to clipboard:",
        err,
      );
      ok = false;
    }
    setCopied(ok);
    await openExternalUrl(branding.bugReportUrl);
  }, [copyToClipboard, formatMarkdown, branding.bugReportUrl]);

  const handleCopyDiagnostics = useCallback(async () => {
    const diagnosticsText = buildDiagnosticsBlock();
    if (!diagnosticsText) return;
    let ok = false;
    try {
      await copyToClipboard(diagnosticsText);
      ok = true;
    } catch (err) {
      console.warn("[BugReportModal] Failed to copy diagnostics:", err);
    }
    setCopiedDiagnostics(ok);
  }, [buildDiagnosticsBlock, copyToClipboard]);

  const handleSaveBundle = useCallback(async () => {
    setSavingBundle(true);
    setErrorMsg(null);
    try {
      const bundle = await createDesktopBugReportBundle({
        prefix: "elizaos-report",
        reportMarkdown: formatMarkdown(),
        reportJson: buildReportPayload(),
      });
      setBundlePath(bundle?.directory ?? null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to create report bundle",
      );
    } finally {
      setSavingBundle(false);
    }
  }, [buildReportPayload, formatMarkdown]);

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
  const canSubmit =
    form.description.trim() && form.stepsToReproduce.trim() && !submitting;

  // Success state
  if (resultUrl || acceptedWithoutUrl) {
    return (
      <Dialog
        open={isOpen}
        onOpenChange={(open: boolean) => {
          if (!open) close();
        }}
      >
        <DialogContent className="w-[min(calc(100%_-_2rem),28rem)] rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl backdrop-blur-xl">
          <DialogHeader className="px-5 py-4 text-left">
            <DialogTitle
              ref={(node) => {
                successHeadingRef.current = node;
              }}
              tabIndex={-1}
              className="text-sm font-bold text-txt focus:outline-none"
            >
              {t("bugreportmodal.BugReportSubmitted")}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted">
              {t("bugreportmodal.YourBugReportHas")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-5 py-6 text-center">
            <p className="text-sm text-txt">
              {acceptedWithoutUrl
                ? "Your report was received."
                : t("bugreportmodal.YourBugReportHas")}
            </p>
            {resultUrl ? (
              <a
                href={resultUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm font-medium text-accent underline-offset-4 hover:underline"
              >
                {resultUrl}
              </a>
            ) : (
              <p className="text-xs text-muted">
                {t("bugreportmodal.DiagnosticsSharedSuccessfully", {
                  defaultValue: "Diagnostics were shared successfully.",
                })}
              </p>
            )}
          </div>
          <DialogFooter className="px-5 py-4 sm:justify-end">
            <Button variant="outline" size="sm" onClick={close}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className={modalContentClassName}
        onOpenAutoFocus={(event: Event) => {
          event.preventDefault();
          descRef.current?.focus();
        }}
      >
        <DialogHeader className="px-5 py-4 text-left">
          <DialogTitle className="text-sm font-bold text-txt">
            {t("bugreportmodal.ReportABug")}
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-muted">
            {t("bugreportmodal.ReproductionPrompt", {
              defaultValue:
                "Help us reproduce the issue with concrete steps and environment details.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex max-h-[min(88vh,52rem)] flex-col"
          aria-busy={submitting}
        >
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {errorMsg && (
              <Banner variant="error" className="rounded-xl text-xs">
                {errorMsg}
              </Banner>
            )}
            {bundlePath && (
              <FieldMessage tone="success" className="text-xs">
                {bundlePath}
              </FieldMessage>
            )}
            <Field>
              <FieldLabel htmlFor="bug-report-description">
                {t("common.description")}{" "}
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              </FieldLabel>
              <Textarea
                ref={descRef}
                id="bug-report-description"
                className={modalTextareaClassName}
                placeholder={t("bugreportmodal.DescribeTheIssueY")}
                value={form.description}
                onChange={(e) => updateField("description", e.target.value)}
                rows={4}
              />
              <FieldDescription className={subtleMonoDescriptionClassName}>
                {t("bugreportmodal.DescriptionHint", {
                  defaultValue:
                    "Describe what happened and why it was unexpected.",
                })}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="bug-report-steps">
                {t("bugreportmodal.StepsToReproduce")}{" "}
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              </FieldLabel>
              <Textarea
                id="bug-report-steps"
                className={modalTextareaClassName}
                placeholder={t("bugreportmodal.stepsPlaceholder")}
                value={form.stepsToReproduce}
                onChange={(e) =>
                  updateField("stepsToReproduce", e.target.value)
                }
                rows={4}
              />
              <FieldDescription className={subtleMonoDescriptionClassName}>
                {t("bugreportmodal.StepsHint", {
                  defaultValue:
                    "Include the shortest reliable path that reproduces the bug.",
                })}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="bug-report-expected">
                {t("bugreportmodal.ExpectedBehavior")}
              </FieldLabel>
              <Textarea
                id="bug-report-expected"
                className={`${modalTextareaClassName} min-h-[72px]`}
                placeholder={t("bugreportmodal.DescribeTheExpecte")}
                value={form.expectedBehavior}
                onChange={(e) =>
                  updateField("expectedBehavior", e.target.value)
                }
                rows={3}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="bug-report-actual">
                {t("bugreportmodal.ActualBehavior")}
              </FieldLabel>
              <Textarea
                id="bug-report-actual"
                className={`${modalTextareaClassName} min-h-[72px]`}
                placeholder={t("bugreportmodal.DescribeTheActual")}
                value={form.actualBehavior}
                onChange={(e) => updateField("actualBehavior", e.target.value)}
                rows={3}
              />
            </Field>

            <div className="grid gap-3 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bug-report-environment">
                  {t("bugreportmodal.Environment")}
                </FieldLabel>
                <Select
                  value={form.environment}
                  onValueChange={(value: string) =>
                    updateField("environment", value)
                  }
                >
                  <SelectTrigger
                    id="bug-report-environment"
                    className={modalInputClassName}
                  >
                    <SelectValue placeholder={t("bugreportmodal.Select")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" disabled>
                      {t("bugreportmodal.Select")}
                    </SelectItem>
                    {ENV_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {environmentOptionLabel(t, opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="bug-report-node-version">
                  {t("bugreportmodal.NodeVersion")}
                </FieldLabel>
                <Input
                  id="bug-report-node-version"
                  className={modalInputClassName}
                  placeholder={t("bugreportmodal.22X")}
                  value={form.nodeVersion}
                  onChange={(e) => updateField("nodeVersion", e.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="bug-report-model-provider">
                {t("bugreportmodal.ModelProvider")}
              </FieldLabel>
              <Input
                id="bug-report-model-provider"
                className={modalInputClassName}
                placeholder={t("bugreportmodal.AnthropicOpenAI")}
                value={form.modelProvider}
                onChange={(e) => updateField("modelProvider", e.target.value)}
              />
            </Field>

            <Field>
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <FieldLabel className="mb-0">{t("common.logs")}</FieldLabel>
                  <FieldDescription className={subtleMonoDescriptionClassName}>
                    {t("bugreportmodal.LogsHint", {
                      defaultValue:
                        "Paste only the relevant errors, traces, or console output.",
                    })}
                  </FieldDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 rounded-xl px-3 text-xs text-muted hover:text-txt"
                  onClick={() => setShowLogs(!showLogs)}
                  aria-expanded={showLogs}
                  aria-controls="bug-report-logs-panel"
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${showLogs ? "rotate-90" : ""}`}
                  />
                  {showLogs
                    ? t("bugreportmodal.HideLogs", {
                        defaultValue: "Hide logs",
                      })
                    : t("bugreportmodal.AddLogs", {
                        defaultValue: "Add logs",
                      })}
                </Button>
              </div>
              {showLogs && (
                <div className="space-y-3">
                  {desktopRuntime ? (
                    <div className="flex flex-wrap gap-4 text-xs-tight text-muted">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={attachLogs}
                          onChange={(e) => setAttachLogs(e.target.checked)}
                        />
                        {t("bugreportmodal.attachLogs")}
                      </label>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={attachSystemInfo}
                          onChange={(e) =>
                            setAttachSystemInfo(e.target.checked)
                          }
                        />
                        {t("bugreportmodal.attachSystemInfo")}
                      </label>
                    </div>
                  ) : null}
                  <Textarea
                    id="bug-report-logs-panel"
                    className={`${modalTextareaClassName} min-h-[120px] font-mono text-xs`}
                    placeholder={t("bugreportmodal.PasteRelevantError")}
                    value={form.logs}
                    onChange={(e) => updateField("logs", e.target.value)}
                    rows={6}
                  />
                </div>
              )}
            </Field>
          </div>

          <DialogFooter className="px-5 py-4 sm:items-center sm:justify-between sm:space-x-0">
            <Button variant="outline" size="sm" onClick={close}>
              {t("common.cancel")}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              {desktopRuntime ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyDiagnostics}
                  >
                    {copiedDiagnostics
                      ? t("bugreportmodal.copiedDiagnostics")
                      : t("bugreportmodal.copyDiagnostics")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openDesktopLogsFolder}
                  >
                    {t("bugreportmodal.openLogsFolder")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveBundle}
                    disabled={savingBundle}
                  >
                    {savingBundle
                      ? t("bugreportmodal.savingBundle")
                      : t("bugreportmodal.saveBundle")}
                  </Button>
                </>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyAndOpen}
                disabled={!canSubmit}
              >
                {copied
                  ? t("bugreportmodal.copied")
                  : t("bugreportmodal.copyAndOpenGitHub")}
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {submitting
                  ? t("bugreportmodal.submitting")
                  : t("common.submit")}
              </Button>
            </div>
          </DialogFooter>

          {copied && !resultUrl ? (
            <FieldMessage
              tone="success"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="px-5 pb-4 pt-0"
            >
              {t("bugreportmodal.ReportCopiedToClipboard", {
                defaultValue: "Report copied to clipboard.",
              })}
            </FieldMessage>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
