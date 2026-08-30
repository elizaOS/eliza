/**
 * Modal form for authoring/editing a single custom action: name, similes,
 * description, parameters, and the handler (HTTP request, shell command, or
 * inline code). Field parsing/validation lives in `custom-action-form.ts`; this
 * component owns the form state and calls `onSave` with the assembled
 * `CustomActionDef`. It can seed itself from a natural-language description via
 * the client's action generation, then let the user refine the parsed result.
 */

import type { CustomActionDef, CustomActionHandler } from "@elizaos/shared";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../api/client";
import { useAppSelector } from "../../state";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";
import {
  editorFieldLabelClassName,
  type HandlerType,
  type HeaderRow,
  HTTP_METHODS,
  type HttpMethod,
  normalizeActionName,
  normalizeMethod,
  normalizeParamName,
  type ParamDef,
  type ParsedGeneration,
  parseGeneratedAction,
  parseSimilesInput,
  validateParameters,
} from "./custom-action-form";

interface CustomActionEditorProps {
  open: boolean;
  action?: CustomActionDef | null;
  onSave: (action: CustomActionDef) => void;
  onClose: () => void;
}

export function CustomActionEditor({
  open,
  action,
  onSave,
  onClose,
}: CustomActionEditorProps) {
  const t = useAppSelector((s) => s.t);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [similesInput, setSimilesInput] = useState("");
  const [handlerType, setHandlerType] = useState<HandlerType>("http");

  // HTTP handler fields
  const [httpMethod, setHttpMethod] = useState<HttpMethod>("GET");
  const [httpUrl, setHttpUrl] = useState("");
  const [httpHeaders, setHttpHeaders] = useState<HeaderRow[]>([
    { key: "", value: "" },
  ]);
  const [httpBody, setHttpBody] = useState("");

  // Shell handler fields
  const [shellCommand, setShellCommand] = useState("");

  // Code handler fields
  const [code, setCode] = useState("");

  // Parameters
  const [parameters, setParameters] = useState<ParamDef[]>([]);

  // AI generate
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

  // Test section
  const [testExpanded, setTestExpanded] = useState(false);
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{
    output?: string;
    error?: string;
    duration?: number;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Populate form when action changes
  useEffect(() => {
    if (!open) return;

    setFormError("");

    if (action) {
      setName(action.name);
      setDescription(action.description || "");
      setSimilesInput((action.similes ?? []).join(", "));
      setParameters(
        action.parameters?.map((p) => ({
          name: p.name,
          description: p.description || "",
          required: p.required || false,
        })) || [],
      );

      const handler = action.handler;
      if (handler.type === "http") {
        setHandlerType("http");
        setHttpMethod((handler.method as HttpMethod) || "GET");
        setHttpUrl(handler.url || "");
        const headers = handler.headers || {};
        setHttpHeaders(
          Object.keys(headers).length > 0
            ? Object.entries(headers).map(([key, value]) => ({
                key,
                value,
              }))
            : [{ key: "", value: "" }],
        );
        setHttpBody(handler.bodyTemplate || "");
      } else if (handler.type === "shell") {
        setHandlerType("shell");
        setShellCommand(handler.command || "");
      } else if (handler.type === "code") {
        setHandlerType("code");
        setCode(handler.code || "");
      }
    } else {
      // Reset for create mode
      setName("");
      setDescription("");
      setSimilesInput("");
      setHandlerType("http");
      setHttpMethod("GET");
      setHttpUrl("");
      setHttpHeaders([{ key: "", value: "" }]);
      setHttpBody("");
      setShellCommand("");
      setCode("");
      setParameters([]);
      setAiPrompt("");
      setTestExpanded(false);
      setTestParams({});
      setTestResult(null);
    }
  }, [open, action]);

  const setNormalizedName = (value: string) => {
    setName(normalizeActionName(value));
    setFormError("");
  };

  const setDescriptionValue = (value: string) => {
    setDescription(value);
    setFormError("");
  };

  const applyGenerated = (parsed: ParsedGeneration) => {
    setName(parsed.name);
    setDescription(parsed.description);
    setSimilesInput(parsed.similes.join(", "));

    if (parsed.handlerType === "http") {
      const handler = parsed.handler as CustomActionHandler & {
        type: "http";
        method: HttpMethod;
      };
      setHandlerType("http");
      setHttpMethod(handler.method || "GET");
      setHttpUrl(handler.url);
      setHttpBody(handler.bodyTemplate || "");
      setHttpHeaders(
        handler.headers
          ? Object.entries(handler.headers).map(([key, value]) => ({
              key,
              value,
            }))
          : [{ key: "", value: "" }],
      );
    } else if (parsed.handlerType === "shell") {
      const handler = parsed.handler as CustomActionHandler & { type: "shell" };
      setHandlerType("shell");
      setShellCommand(handler.command);
    } else {
      const handler = parsed.handler as CustomActionHandler & { type: "code" };
      setHandlerType("code");
      setCode(handler.code);
    }

    setParameters(parsed.parameters);
    setFormError("");
    setAiPrompt("");
  };

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    setFormError("");

    try {
      const result = await client.generateCustomAction(aiPrompt.trim());
      if (!result.ok || !result.generated) {
        setFormError("AI generation returned no action definition.");
        return;
      }

      const parsed = parseGeneratedAction(result.generated);
      if (!parsed.ok || !parsed.action) {
        setFormError(
          parsed.errors.length > 0
            ? parsed.errors.join(" ")
            : "AI generation was incomplete.",
        );
        return;
      }

      applyGenerated(parsed.action);
    } catch (err: unknown) {
      setFormError(
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setGenerating(false);
    }
  };

  const addParameter = () => {
    setParameters([
      ...parameters,
      { name: "", description: "", required: false },
    ]);
  };

  const removeParameter = (index: number) => {
    setParameters(parameters.filter((_, i) => i !== index));
  };

  const updateParameter = (
    index: number,
    field: keyof ParamDef,
    value: string | boolean,
  ) => {
    setParameters((prevParameters) =>
      prevParameters.map((parameter, i) => {
        if (i !== index) {
          return parameter;
        }

        if (field === "name") {
          return {
            ...parameter,
            [field]: normalizeParamName(value as string),
          };
        }

        return {
          ...parameter,
          [field]: value,
        };
      }),
    );
    setFormError("");
  };

  const addHeader = () => {
    setHttpHeaders([...httpHeaders, { key: "", value: "" }]);
  };

  const removeHeader = (index: number) => {
    setHttpHeaders(httpHeaders.filter((_, i) => i !== index));
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    setHttpHeaders((prevHeaders) =>
      prevHeaders.map((header, i) =>
        i === index ? { ...header, [field]: value } : header,
      ),
    );
    setFormError("");
  };

  const buildHeaders = (): Record<string, string> | undefined => {
    const headers: Record<string, string> = {};

    for (const header of httpHeaders) {
      const key = header.key.trim();
      if (key) {
        headers[key] = header.value;
      }
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setFormError("");

    try {
      const actionName = normalizeActionName(name);
      const actionDescription = description.trim();

      if (!actionName) {
        setFormError("Name is required.");
        return;
      }

      if (!actionDescription) {
        setFormError("Description is required.");
        return;
      }

      const normalizedParameters = [...parameters];
      const validationError = validateParameters(normalizedParameters);
      if (validationError) {
        setFormError(validationError);
        return;
      }

      let handler: CustomActionHandler;

      if (handlerType === "http") {
        if (!httpUrl.trim()) {
          setFormError("HTTP URL is required.");
          return;
        }

        const headers = buildHeaders();

        handler = {
          type: "http",
          method: normalizeMethod(httpMethod),
          url: httpUrl,
          headers,
          bodyTemplate: httpBody || undefined,
        };
      } else if (handlerType === "shell") {
        if (!shellCommand.trim()) {
          setFormError("Shell command is required.");
          return;
        }

        handler = {
          type: "shell",
          command: shellCommand,
        };
      } else {
        if (!code.trim()) {
          setFormError("Code is required.");
          return;
        }

        handler = {
          type: "code",
          code,
        };
      }

      const similes = parseSimilesInput(similesInput);

      const actionDef = {
        name: actionName,
        description: actionDescription,
        similes,
        parameters: normalizedParameters,
        handler,
        enabled: action?.enabled ?? true,
      };

      const saved = action?.id
        ? await client.updateCustomAction(action.id, actionDef)
        : await client.createCustomAction(actionDef);

      onSave(saved);
      setAiPrompt("");
      setFormError("");
    } catch (err: unknown) {
      setFormError(
        `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);

    // Auto-save if the action hasn't been saved yet
    let actionId = action?.id;
    if (!actionId) {
      try {
        await handleSave();
        // After save, the action should have an ID
        actionId = action?.id;
        if (!actionId) {
          setTestResult({
            error:
              "Failed to save action before testing. Please save manually first.",
          });
          setTesting(false);
          return;
        }
      } catch (err) {
        setTestResult({
          error: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        setTesting(false);
        return;
      }
    }

    const startTime = Date.now();

    try {
      const result = await client.testCustomAction(actionId, testParams);
      const duration = Date.now() - startTime;
      setTestResult({
        output: result.error ? undefined : JSON.stringify(result, null, 2),
        error: result.error || undefined,
        duration,
      });
    } catch (err: unknown) {
      const duration = Date.now() - startTime;
      setTestResult({
        error: err instanceof Error ? err.message : String(err),
        duration,
      });
    } finally {
      setTesting(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(calc(100%_-_2rem),48rem)] max-h-[min(90vh,56rem)] p-0"
      >
        {/* Header */}
        <DialogHeader className="flex flex-row items-center px-5 py-4">
          <DialogTitle className="flex-1 text-sm font-medium text-txt">
            {action ? "Edit Custom Action" : "New Custom Action"}
          </DialogTitle>
          <Button
            variant="ghostMuted"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogHeader>

        {/* Body */}
        <div className="flex max-h-[min(72vh,44rem)] flex-col gap-4 overflow-y-auto px-5 py-4">
          {formError && <Banner variant="error">{formError}</Banner>}

          {/* AI Generate */}
          {!action && (
            <Card variant="panel">
              <div className="flex flex-col gap-2 p-3">
                <span className="text-xs text-txt font-medium">
                  {t("customactioneditor.DescribeWhatYouWa")}
                </span>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={aiPrompt}
                    onChange={(e) => {
                      setAiPrompt(e.target.value);
                      setFormError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !generating) {
                        void handleGenerate();
                      }
                    }}
                    placeholder={t("customactioneditor.eGCheckIfAWebs")}
                    variant="surface"
                    className="flex-1"
                  />
                  <Button
                    variant="default"
                    size="sm"
                    className="whitespace-nowrap"
                    onClick={handleGenerate}
                    disabled={generating || !aiPrompt.trim()}
                  >
                    {generating ? "Generating…" : "Generate"}
                  </Button>
                </div>
                <span className="text-xs text-muted">
                  {t("customactioneditor.TheAgentWillGener")}
                </span>
              </div>
            </Card>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1">
            <span className={editorFieldLabelClassName}>
              {t("common.name")}
            </span>
            <Input
              type="text"
              value={name}
              onChange={(e) => setNormalizedName(e.target.value)}
              placeholder={t("customactioneditor.MYACTION")}
              variant="surface"
              className="flex-1"
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1">
            <span className={editorFieldLabelClassName}>
              {t("common.description")}
            </span>
            <Textarea
              value={description}
              onChange={(e) => setDescriptionValue(e.target.value)}
              placeholder={t("customactioneditor.WhatDoesThisActio")}
              rows={2}
              variant="modal"
              className="flex-1 resize-none"
            />
          </div>

          {/* Similes */}
          <div className="flex flex-col gap-1">
            <span className={editorFieldLabelClassName}>
              {t("customactioneditor.AliasesOptional")}
            </span>
            <Input
              type="text"
              value={similesInput}
              onChange={(e) => {
                setSimilesInput(e.target.value);
                setFormError("");
              }}
              placeholder={t("customactioneditor.SYNONYMONESYNONYM")}
              variant="surface"
              className="flex-1"
            />
            <span className="text-xs text-muted">
              {t("customactioneditor.CommaSeparatedAlte")}
            </span>
          </div>

          {/* Handler Type Tabs */}
          <div className="flex flex-col gap-1">
            <span className={editorFieldLabelClassName}>
              {t("customactioneditor.HandlerType")}
            </span>
            <div className="flex gap-2">
              {(["http", "shell", "code"] as const).map((type) => (
                <Button
                  variant="choice"
                  size="compact"
                  data-state={handlerType === type ? "on" : "off"}
                  key={type}
                  onClick={() => {
                    setHandlerType(type);
                    setFormError("");
                  }}
                >
                  {type === "http"
                    ? "HTTP Request"
                    : type === "shell"
                      ? "Shell Command"
                      : "JavaScript"}
                </Button>
              ))}
            </div>
          </div>

          {/* Handler Config */}
          {handlerType === "http" && (
            <Card variant="panel">
              <div className="flex flex-col gap-3 p-3">
                <div className="flex gap-2">
                  <Select
                    value={httpMethod}
                    onValueChange={(value: string) =>
                      setHttpMethod(value as HttpMethod)
                    }
                  >
                    <SelectTrigger
                      aria-label="HTTP method"
                      variant="modal"
                      className="w-auto min-w-[6.5rem]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HTTP_METHODS.map((method) => (
                        <SelectItem key={method} value={method}>
                          {method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="text"
                    value={httpUrl}
                    onChange={(e) => {
                      setHttpUrl(e.target.value);
                      setFormError("");
                    }}
                    placeholder={t("customactioneditor.httpsApiExample")}
                    variant="surface"
                    className="flex-1"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className={editorFieldLabelClassName}>
                      {t("customactioneditor.HeadersOptional")}
                    </span>
                    <Button
                      variant="mutedLink"
                      size="content"
                      onClick={addHeader}
                    >
                      {t("customactioneditor.Add")}
                    </Button>
                  </div>
                  {httpHeaders.map((header, i) => (
                    <div
                      key={`${header.key}:${header.value}`}
                      className="flex gap-2"
                    >
                      <Input
                        type="text"
                        value={header.key}
                        onChange={(e) => updateHeader(i, "key", e.target.value)}
                        placeholder={t("customactioneditor.HeaderName")}
                        variant="surface"
                        className="flex-1"
                      />
                      <Input
                        type="text"
                        value={header.value}
                        onChange={(e) =>
                          updateHeader(i, "value", e.target.value)
                        }
                        placeholder={t("customactioneditor.valueOrParam")}
                        variant="surface"
                        className="flex-1"
                      />
                      <Button
                        variant="ghostMuted"
                        size="inlineIcon"
                        onClick={() => removeHeader(i)}
                        aria-label={`Remove header ${i + 1}`}
                      >
                        {t("bugreportmodal.Times")}
                      </Button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-1">
                  <span className={editorFieldLabelClassName}>
                    {t("customactioneditor.BodyTemplateOptio")}
                  </span>
                  <Textarea
                    value={httpBody}
                    onChange={(e) => {
                      setHttpBody(e.target.value);
                      setFormError("");
                    }}
                    placeholder={'{"key": "{{param}}"}'}
                    rows={3}
                    variant="modal"
                    className="resize-none font-mono"
                  />
                </div>
              </div>
            </Card>
          )}

          {handlerType === "shell" && (
            <div className="flex flex-col gap-1">
              <span className={editorFieldLabelClassName}>
                {t("customactioneditor.CommandTemplate")}
              </span>
              <Textarea
                value={shellCommand}
                onChange={(e) => {
                  setShellCommand(e.target.value);
                  setFormError("");
                }}
                placeholder={t("customactioneditor.echoMessage")}
                rows={4}
                variant="modal"
                className="resize-none font-mono"
              />
              <span className="text-xs text-muted">
                {t("streamsettings.Use")} {`{{paramName}}`}{" "}
                {t("customactioneditor.forParameterSubsti")}
              </span>
            </div>
          )}

          {handlerType === "code" && (
            <div className="flex flex-col gap-1">
              <span className={editorFieldLabelClassName}>
                {t("customactioneditor.JavaScriptCode")}
              </span>
              <Textarea
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setFormError("");
                }}
                placeholder={t("customactioneditor.AvailableParams")}
                rows={6}
                variant="modal"
                className="resize-none font-mono"
              />
            </div>
          )}

          {/* Parameters */}
          <div className="flex flex-col gap-2 pt-3">
            <div className="flex items-center justify-between">
              <span className={editorFieldLabelClassName}>
                {t("common.parameters")}
              </span>
              <Button variant="mutedLink" size="content" onClick={addParameter}>
                {t("customactioneditor.AddParameter")}
              </Button>
            </div>
            {parameters.map((param, paramIdx) => (
              <div
                key={`${param.name}-${param.description ?? ""}`}
                className="flex gap-2 items-start"
              >
                <Input
                  type="text"
                  value={param.name}
                  onChange={(e) =>
                    updateParameter(paramIdx, "name", e.target.value)
                  }
                  placeholder={t("customactioneditor.paramName")}
                  variant="surface"
                  className="w-32"
                />
                <Input
                  type="text"
                  value={param.description}
                  onChange={(e) =>
                    updateParameter(paramIdx, "description", e.target.value)
                  }
                  placeholder={t("common.description")}
                  variant="surface"
                  className="flex-1"
                />
                <span className="flex items-center gap-1 text-xs text-muted cursor-pointer">
                  <Checkbox
                    checked={param.required}
                    aria-label={t("secretsview.Required")}
                    onCheckedChange={(checked: boolean | "indeterminate") =>
                      updateParameter(paramIdx, "required", !!checked)
                    }
                  />

                  {t("secretsview.Required")}
                </span>
                <Button
                  variant="ghostMuted"
                  size="inlineIcon"
                  onClick={() => removeParameter(paramIdx)}
                  aria-label={`Remove parameter ${param.name || paramIdx + 1}`}
                >
                  {t("bugreportmodal.Times")}
                </Button>
              </div>
            ))}
          </div>

          {/* Test Section */}
          <div className="flex flex-col gap-2 pt-3">
            <Button
              variant="disclosureMuted"
              size="content"
              onClick={() => setTestExpanded((expanded) => !expanded)}
            >
              <span>{t("customactioneditor.TestAction")}</span>
              <span>
                {testExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </span>
            </Button>
            {testExpanded && (
              <div className="flex gap-2">
                <Separator
                  orientation="vertical"
                  className="h-auto self-stretch"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {parameters
                    .filter((p) => p.name.trim())
                    .map((param) => (
                      <div key={param.name} className="flex flex-col gap-1">
                        <span className={editorFieldLabelClassName}>
                          {param.name}
                        </span>
                        <Input
                          type="text"
                          value={testParams[param.name] || ""}
                          onChange={(e) =>
                            setTestParams({
                              ...testParams,
                              [param.name]: e.target.value,
                            })
                          }
                          placeholder={param.description || "value"}
                          variant="surface"
                        />
                      </div>
                    ))}
                  {testResult && (
                    <Card variant="insetCompact">
                      <div className="font-mono text-xs">
                        {testResult.error && (
                          <div className="text-status-danger">
                            {t("customactioneditor.Error")} {testResult.error}
                          </div>
                        )}
                        {testResult.output && (
                          <pre className="text-txt whitespace-pre-wrap">
                            {testResult.output}
                          </pre>
                        )}
                        {testResult.duration !== undefined && (
                          <div className="text-muted mt-1">
                            {t("customactioneditor.Duration")}{" "}
                            {testResult.duration}
                            ms
                          </div>
                        )}
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-4 sm:justify-end sm:space-x-2">
          {testExpanded && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testing || saving}
            >
              {testing
                ? t("common.testing", {
                    defaultValue: "Testing...",
                  })
                : t("customactioneditor.Test", {
                    defaultValue: "Test",
                  })}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving
              ? t("common.saving", {
                  defaultValue: "Saving...",
                })
              : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
