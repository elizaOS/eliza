import {
  type CustomActionDef,
  type CustomActionHandler,
  client,
} from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { Button } from "@elizaos/ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

interface CustomActionEditorProps {
  open: boolean;
  action?: CustomActionDef | null;
  onSave: (action: CustomActionDef) => void;
  onClose: () => void;
}

type HandlerType = "http" | "shell" | "code";
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface ParamDef {
  name: string;
  description: string;
  required: boolean;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface ParsedGeneration {
  name: string;
  description: string;
  handlerType: HandlerType;
  handler: CustomActionHandler;
  parameters: ParamDef[];
  similes: string[];
  enabled: boolean;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
const METHODS_SET = new Set<string>(HTTP_METHODS);

const HTTP_METHODS_LIST = HTTP_METHODS;

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeActionName(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAlias(value: string): string {
  return normalizeActionName(value);
}

function normalizeParamName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeMethod(value: unknown): HttpMethod {
  const method = toNonEmptyString(value)?.toUpperCase();
  return method && METHODS_SET.has(method) ? (method as HttpMethod) : "GET";
}

function parseHeaders(value: unknown): HeaderRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, rawValue]) => {
    const trimmedKey = normalizeParamName(key);
    if (!trimmedKey) return [];
    if (typeof rawValue !== "string") return [];
    return [{ key: key.trim(), value: rawValue }];
  });
}

function parseParameters(value: unknown): ParamDef[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();

  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;

      const candidate = raw as {
        name?: unknown;
        description?: unknown;
        required?: unknown;
      };

      const rawName = toNonEmptyString(candidate.name);
      if (!rawName) return null;

      const name = normalizeParamName(rawName);
      if (!name || seen.has(name.toLowerCase())) return null;
      seen.add(name.toLowerCase());

      return {
        name,
        description: toNonEmptyString(candidate.description) || name,
        required: candidate.required === true,
      } satisfies ParamDef;
    })
    .filter((param): param is ParamDef => param !== null);
}

function parseSimiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();

  return value
    .map((raw) => toNonEmptyString(raw) || "")
    .map((simile) => normalizeAlias(simile))
    .filter((simile) => simile.length > 0)
    .filter((simile) => {
      const key = simile.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function parseGeneratedAction(payload: unknown): {
  ok: boolean;
  action?: ParsedGeneration;
  errors: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["Generation returned an invalid payload."] };
  }

  const raw = payload as Record<string, unknown>;

  const name = normalizeActionName(raw.name?.toString() ?? "");
  const description = toNonEmptyString(raw.description) ?? "";

  if (!name) {
    return {
      ok: false,
      errors: ["Generated action must include a name."],
    };
  }

  const handlerSource = raw.handler;
  if (
    !handlerSource ||
    typeof handlerSource !== "object" ||
    Array.isArray(handlerSource)
  ) {
    return {
      ok: false,
      errors: ["Generated action must include a handler block."],
    };
  }

  const hTypeRaw =
    toNonEmptyString((raw as { handlerType?: unknown }).handlerType) ??
    toNonEmptyString((handlerSource as { type?: unknown }).type);
  const handlerType = hTypeRaw?.toLowerCase() as HandlerType | undefined;

  if (
    handlerType !== "http" &&
    handlerType !== "shell" &&
    handlerType !== "code"
  ) {
    return {
      ok: false,
      errors: ["Generated handler type must be http, shell, or code."],
    };
  }

  const params = parseParameters(raw.parameters);

  if (handlerType === "http") {
    const rawHttp = handlerSource as {
      method?: unknown;
      url?: unknown;
      headers?: unknown;
      bodyTemplate?: unknown;
      methodType?: unknown;
      type?: unknown;
    };

    const url = toNonEmptyString(rawHttp.url);
    if (!url) {
      return {
        ok: false,
        errors: ["HTTP action requires a URL."],
      };
    }

    const handler: CustomActionHandler = {
      type: "http",
      method: normalizeMethod(rawHttp.method ?? rawHttp.methodType),
      url,
      headers: parseHeaders(rawHttp.headers).length
        ? parseHeaders(rawHttp.headers).reduce<Record<string, string>>(
            (acc, item) => {
              if (item.key) {
                acc[item.key] = item.value;
              }
              return acc;
            },
            {},
          )
        : undefined,
      bodyTemplate: toNonEmptyString(rawHttp.bodyTemplate),
    };

    return {
      ok: true,
      action: {
        name,
        description,
        handlerType,
        handler,
        parameters: params,
        similes: parseSimiles(raw.similes),
        enabled: raw.enabled === true,
      },
      errors: [],
    };
  }

  if (handlerType === "shell") {
    const rawShell = handlerSource as {
      command?: unknown;
    };

    const command = toNonEmptyString(rawShell.command);
    if (!command) {
      return {
        ok: false,
        errors: ["Shell action requires a command template."],
      };
    }

    return {
      ok: true,
      action: {
        name,
        description,
        handlerType,
        handler: {
          type: "shell",
          command,
        },
        parameters: params,
        similes: parseSimiles(raw.similes),
        enabled: raw.enabled === true,
      },
      errors: [],
    };
  }

  const rawCode = handlerSource as {
    code?: unknown;
    source?: unknown;
  };
  const code =
    toNonEmptyString(rawCode.code) ?? toNonEmptyString(rawCode.source);

  if (!code) {
    return {
      ok: false,
      errors: ["Code action requires a JavaScript code block."],
    };
  }

  return {
    ok: true,
    action: {
      name,
      description,
      handlerType,
      handler: {
        type: "code",
        code,
      },
      parameters: params,
      similes: parseSimiles(raw.similes),
      enabled: raw.enabled === true,
    },
    errors: [],
  };
}

function parseSimilesInput(value: string): string[] {
  return value
    .split(",")
    .map((raw) => normalizeAlias(raw))
    .filter(Boolean);
}

export function CustomActionEditor({
  open,
  action,
  onSave,
  onClose,
}: CustomActionEditorProps) {
  const { t } = useApp();
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

  const validateParameters = (items: ParamDef[]): string | null => {
    const seen = new Set<string>();

    for (const parameter of items) {
      const normalized = normalizeParamName(parameter.name);
      if (!normalized) {
        return "Each parameter needs a non-empty name.";
      }

      if (seen.has(normalized.toLowerCase())) {
        return `Duplicate parameter name: ${normalized}`;
      }

      seen.add(normalized.toLowerCase());
      parameter.name = normalized;
    }

    return null;
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
    if (!action?.id) {
      setTestResult({ error: "Save the action first to test it." });
      return;
    }

    setTesting(true);
    setTestResult(null);
    const startTime = Date.now();

    try {
      const result = await client.testCustomAction(action.id, testParams);
      const duration = Date.now() - startTime;
      setTestResult({
        output: JSON.stringify(result, null, 2),
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl border border-border bg-card shadow-lg flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center px-5 py-3 border-b border-border shrink-0">
          <h2 className="flex-1 text-sm font-medium text-txt">
            {action ? "Edit Custom Action" : "New Custom Action"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted text-xl leading-none"
            onClick={onClose}
          >
            {t("bugreportmodal.Times")}
          </Button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          {formError && (
            <div className="border border-danger/30 bg-danger/10 text-danger px-3 py-2 text-xs rounded">
              {formError}
            </div>
          )}

          {/* AI Generate */}
          {!action && (
            <div className="flex flex-col gap-1 border border-accent/30 bg-accent/5 p-3">
              <span className="text-xs text-txt font-medium">
                {t("customactioneditor.DescribeWhatYouWa")}
              </span>
              <div className="flex gap-2">
                <input
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
                  className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                />
                <Button
                  variant="default"
                  size="sm"
                  className="whitespace-nowrap"
                  onClick={handleGenerate}
                  disabled={generating || !aiPrompt.trim()}
                >
                  {generating ? "Generating..." : "Generate"}
                </Button>
              </div>
              <span className="text-xs text-muted/70">
                {t("customactioneditor.TheAgentWillGener")}
              </span>
            </div>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t("triggersview.Name")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setNormalizedName(e.target.value)}
              placeholder={t("customactioneditor.MYACTION")}
              className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              {t("skillsview.Description")}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescriptionValue(e.target.value)}
              placeholder={t("customactioneditor.WhatDoesThisActio")}
              rows={2}
              className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent resize-none"
            />
          </div>

          {/* Similes */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              {t("customactioneditor.AliasesOptional")}
            </span>
            <input
              type="text"
              value={similesInput}
              onChange={(e) => {
                setSimilesInput(e.target.value);
                setFormError("");
              }}
              placeholder={t("customactioneditor.SYNONYMONESYNONYM")}
              className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
            />
            <span className="text-xs text-muted/70">
              {t("customactioneditor.CommaSeparatedAlte")}
            </span>
          </div>

          {/* Handler Type Tabs */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              {t("customactioneditor.HandlerType")}
            </span>
            <div className="flex gap-2">
              {(["http", "shell", "code"] as const).map((type) => (
                <button
                  type="button"
                  key={type}
                  onClick={() => {
                    setHandlerType(type);
                    setFormError("");
                  }}
                  className={`px-3 py-1.5 text-xs border cursor-pointer ${
                    handlerType === type
                      ? "border-accent bg-accent text-[var(--accent-foreground,#1a1f26)]"
                      : "border-border text-muted hover:text-txt"
                  }`}
                >
                  {type === "http"
                    ? "HTTP Request"
                    : type === "shell"
                      ? "Shell Command"
                      : "JavaScript"}
                </button>
              ))}
            </div>
          </div>

          {/* Handler Config */}
          {handlerType === "http" && (
            <div className="flex flex-col gap-3 border border-border p-3">
              <div className="flex gap-2">
                <select
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value as HttpMethod)}
                  className="bg-surface border border-border px-2 py-1.5 text-sm text-txt outline-none focus:border-accent"
                >
                  {HTTP_METHODS_LIST.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={httpUrl}
                  onChange={(e) => {
                    setHttpUrl(e.target.value);
                    setFormError("");
                  }}
                  placeholder={t("customactioneditor.httpsApiExample")}
                  className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted">
                    {t("customactioneditor.HeadersOptional")}
                  </span>
                  <button
                    type="button"
                    onClick={addHeader}
                    className="text-xs text-txt hover:opacity-80 cursor-pointer"
                  >
                    {t("customactioneditor.Add")}
                  </button>
                </div>
                {httpHeaders.map((header, i) => (
                  <div
                    key={`${header.key}:${header.value}`}
                    className="flex gap-2"
                  >
                    <input
                      type="text"
                      value={header.key}
                      onChange={(e) => updateHeader(i, "key", e.target.value)}
                      placeholder={t("customactioneditor.HeaderName")}
                      className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                    />
                    <input
                      type="text"
                      value={header.value}
                      onChange={(e) => updateHeader(i, "value", e.target.value)}
                      placeholder={t("customactioneditor.valueOrParam")}
                      className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => removeHeader(i)}
                      className="px-2 text-muted hover:text-txt cursor-pointer"
                    >
                      {t("bugreportmodal.Times")}
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">
                  {t("customactioneditor.BodyTemplateOptio")}
                </span>
                <textarea
                  value={httpBody}
                  onChange={(e) => {
                    setHttpBody(e.target.value);
                    setFormError("");
                  }}
                  placeholder={'{"key": "{{param}}"}'}
                  rows={3}
                  className="bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent resize-none font-mono"
                />
              </div>
            </div>
          )}

          {handlerType === "shell" && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">
                {t("customactioneditor.CommandTemplate")}
              </span>
              <textarea
                value={shellCommand}
                onChange={(e) => {
                  setShellCommand(e.target.value);
                  setFormError("");
                }}
                placeholder={t("customactioneditor.echoMessage")}
                rows={4}
                className="bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent resize-none font-mono"
              />
              <span className="text-xs text-muted/70">
                {t("streamsettings.Use")} {`{{paramName}}`}{" "}
                {t("customactioneditor.forParameterSubsti")}
              </span>
            </div>
          )}

          {handlerType === "code" && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">
                {t("customactioneditor.JavaScriptCode")}
              </span>
              <textarea
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setFormError("");
                }}
                placeholder={t("customactioneditor.AvailableParams")}
                rows={6}
                className="bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent resize-none font-mono"
              />
            </div>
          )}

          {/* Parameters */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">
                {t("customactioneditor.Parameters")}
              </span>
              <button
                type="button"
                onClick={addParameter}
                className="text-xs text-txt hover:opacity-80 cursor-pointer"
              >
                {t("customactioneditor.AddParameter")}
              </button>
            </div>
            {parameters.map((param, paramIdx) => (
              <div
                key={`${param.name}-${param.description ?? ""}`}
                className="flex gap-2 items-start"
              >
                <input
                  type="text"
                  value={param.name}
                  onChange={(e) =>
                    updateParameter(paramIdx, "name", e.target.value)
                  }
                  placeholder={t("customactioneditor.paramName")}
                  className="w-32 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                />
                <input
                  type="text"
                  value={param.description}
                  onChange={(e) =>
                    updateParameter(paramIdx, "description", e.target.value)
                  }
                  placeholder={t("skillsview.Description")}
                  className="flex-1 bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                />
                <span className="flex items-center gap-1 text-xs text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={param.required}
                    onChange={(e) =>
                      updateParameter(paramIdx, "required", e.target.checked)
                    }
                    className="cursor-pointer"
                  />

                  {t("customactioneditor.Required")}
                </span>
                <button
                  type="button"
                  onClick={() => removeParameter(paramIdx)}
                  className="px-2 text-muted hover:text-txt cursor-pointer"
                >
                  {t("bugreportmodal.Times")}
                </button>
              </div>
            ))}
          </div>

          {/* Test Section */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setTestExpanded((expanded) => !expanded)}
              className="flex items-center justify-between text-xs text-muted hover:text-txt cursor-pointer"
            >
              <span>{t("customactioneditor.TestAction")}</span>
              <span>
                {testExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </span>
            </button>
            {testExpanded && (
              <div className="flex flex-col gap-2 pl-2 border-l-2 border-border">
                {parameters
                  .filter((p) => p.name.trim())
                  .map((param) => (
                    <div key={param.name} className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{param.name}</span>
                      <input
                        type="text"
                        value={testParams[param.name] || ""}
                        onChange={(e) =>
                          setTestParams({
                            ...testParams,
                            [param.name]: e.target.value,
                          })
                        }
                        placeholder={param.description || "value"}
                        className="bg-surface border border-border px-2 py-1.5 text-sm text-txt placeholder:text-muted/50 outline-none focus:border-accent"
                      />
                    </div>
                  ))}
                {testResult && (
                  <div className="bg-surface border border-border p-2 text-xs font-mono">
                    {testResult.error && (
                      <div className="text-red-400">
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
                        {t("customactioneditor.Duration")} {testResult.duration}
                        ms
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          {testExpanded && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testing || !action?.id}
            >
              {testing ? "Testing..." : "Test"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("onboarding.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
