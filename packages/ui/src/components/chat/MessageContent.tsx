import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import { splitLeadingSlashCommand } from "../../chat/slash-menu";
import type { UiSpec } from "../../config/ui-spec";
import { CONNECT_EVENT, dispatchAppEvent } from "../../events";
import { normalizeRemoteAgentUrl } from "../../first-run/adopt-remote-first-run";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { isDesktopPlatform, isNative } from "../../platform";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { useAppSelectorShallow } from "../../state";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import {
  createClientPermissionsRegistry,
  type PermissionCardPayload,
} from "../composites/chat/permission-card.helpers";
import { renderPermissionCardFromPayload } from "../composites/chat/permission-card.render";
import { ConfigRenderer } from "../config-ui/config-renderer";
import { defaultRegistry } from "../config-ui/config-renderer.helpers";
import { UiRenderer } from "../config-ui/ui-renderer";
import { Button } from "../ui/button";
import { CodeBlock } from "../ui/code-block";
import { ErrorBoundary } from "../ui/error-boundary";
import { Input } from "../ui/input";
import { AccountConnectBlock } from "./AccountConnectBlock";
import { MessageAttachments } from "./MessageAttachments";
import {
  buildInlinePluginConfigModel,
  isSafeNormalizedPluginId,
  normalizePluginId,
  parseSegments,
  sensitiveRequestStatusLabel,
  sensitiveRequestTitleLabel,
  splitInlineCode,
} from "./message-parser-helpers";
import { ThinkingBlock } from "./ThinkingBlock";
// Side effect: registers the built-in inline widgets (choice/followups/form/task).
import "./widgets/inline-builtins";
import { getInlineWidget } from "./widgets/inline-registry";
import { useInlineWidgetContext } from "./widgets/use-inline-widget-context";

interface MessageContentProps {
  message: ConversationMessage;
  analysisMode?: boolean;
}

/**
 * Render a text run, wrapping any inline `` `code` `` spans in the CodeBlock
 * inline primitive so they keep their place in the sentence. Returns the raw
 * string unchanged when there is no backticked span (the common case).
 */
/**
 * An OAuth authorizationUrl is an agent/cloud-supplied field that flows into
 * window.open(). A hosted consent screen is always https, so require https and
 * reject anything else — a `javascript:`/`data:` value would otherwise execute
 * in the opened window. `new URL()` also normalizes away control-char scheme
 * obfuscation (e.g. `java\tscript:`).
 */
function isHttpsAuthorizationUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function renderInlineText(text: string): ReactNode {
  if (!text.includes("`")) return text;
  const parts = splitInlineCode(text);
  if (parts.length === 1 && parts[0].kind === "text") return text;
  // Key by the part's character offset in the source run (not the array index)
  // so keys stay stable across re-renders and don't trip noArrayIndexKey.
  let offset = 0;
  return parts.map((part) => {
    const content = part.kind === "code" ? part.code : part.text;
    const key = `${part.kind}:${offset}`;
    offset += content.length;
    return part.kind === "code" ? (
      <CodeBlock
        key={key}
        variant="inline"
        value={part.code}
        data-testid="inline-code"
      />
    ) : (
      <span key={key}>{part.text}</span>
    );
  });
}

/**
 * Render a plain-text message body. When the message is a user-typed slash
 * command (e.g. `/imagine a cat`), the leading `/command` token is rendered in
 * bold so it reads as a command in the transcript — matching the inline
 * autocomplete the composer shows while typing. Inline `` `code` `` spans render
 * in the inline code primitive while staying in the flow of the sentence.
 */
function MessageTextBody({
  text,
  boldSlashCommand,
}: {
  text: string;
  boldSlashCommand: boolean;
}) {
  const slash = boldSlashCommand ? splitLeadingSlashCommand(text) : null;
  return (
    <div className="whitespace-pre-wrap">
      {slash ? (
        <>
          <span
            className="font-bold text-txt"
            data-testid="slash-command-token"
          >
            {slash.command}
          </span>
          {renderInlineText(slash.rest)}
        </>
      ) : (
        renderInlineText(text)
      )}
    </div>
  );
}

// ── InlinePluginConfig ──────────────────────────────────────────────

export function InlinePluginConfig({
  pluginId: rawPluginId,
}: {
  pluginId: string;
}) {
  const pluginId = normalizePluginId(rawPluginId);
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setActionNotice, loadPlugins, t } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
    loadPlugins: s.loadPlugins,
    t: s.t,
  }));

  // Track mount state — reset to true on each mount (needed for StrictMode
  // which unmounts/remounts and would leave the ref false otherwise).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Self-contained: fetch plugin data directly from API
  const fetchPlugin = useCallback(async () => {
    try {
      const { plugins } = await client.getPlugins();
      if (!mountedRef.current) return;
      const found = plugins.find((p) => p.id === pluginId);
      setPlugin(found ?? null);
    } catch {
      if (mountedRef.current) {
        setError(
          t("messagecontent.LoadPluginInfoFailed", {
            defaultValue: "Couldn't load plugin info.",
          }),
        );
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [pluginId, t]);

  useEffect(() => {
    void fetchPlugin();
  }, [fetchPlugin]);

  const { hasConfigurableParams, hints, mergedValues, schema, setKeys } =
    useMemo(
      () => buildInlinePluginConfigModel(plugin, values),
      [plugin, values],
    );

  const handleChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v != null && v !== "") patch[k] = String(v);
      }
      await client.updatePlugin(pluginId, { config: patch });
      if (mountedRef.current) setSaved(true);
      await fetchPlugin();
    } catch (e: unknown) {
      if (mountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("messagecontent.SaveFailed", {
                defaultValue: "Couldn't save changes.",
              }),
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [pluginId, values, fetchPlugin, t]);

  const handleToggle = useCallback(
    async (enable: boolean) => {
      setEnabling(true);
      setError(null);
      try {
        // Save pending config first, then toggle — same as the Plugins page
        if (enable) {
          const patch: Record<string, string> = {};
          for (const [k, v] of Object.entries(values)) {
            if (v != null && v !== "") patch[k] = String(v);
          }
          if (Object.keys(patch).length > 0) {
            await client.updatePlugin(pluginId, { config: patch });
          }
        }
        // Exact same call as the ON button in PluginsView
        await client.updatePlugin(pluginId, { enabled: enable });
        // Refresh shared plugin state so Plugins page shows updated status
        await loadPlugins();
        if (enable && mountedRef.current) {
          const tabLabel =
            plugin?.category === "feature"
              ? t("messagecontent.FeaturesTabLabel", {
                  defaultValue: "Plugins > Features",
                })
              : plugin?.category === "connector"
                ? t("messagecontent.ConnectorsTabLabel", {
                    defaultValue: "Plugins > Connectors",
                  })
                : t("messagecontent.SystemTabLabel", {
                    defaultValue: "Plugins > System",
                  });
          setActionNotice(
            t("messagecontent.PluginEnabledNotice", {
              defaultValue: "{{name}} is on. Find it in {{tabLabel}}.",
              name: plugin?.name ?? pluginId,
              tabLabel,
            }),
            "success",
            4000,
          );
          setDismissed(true);
        }
        // Wait for agent restart then refresh (with cleanup on unmount)
        refreshTimerRef.current = setTimeout(() => void fetchPlugin(), 3000);
      } catch (e: unknown) {
        if (mountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : enable
                ? t("messagecontent.EnablePluginFailed", {
                    defaultValue: "Couldn't enable this plugin.",
                  })
                : t("messagecontent.DisablePluginFailed", {
                    defaultValue: "Couldn't disable this plugin.",
                  }),
          );
        }
      } finally {
        if (mountedRef.current) setEnabling(false);
      }
    },
    [pluginId, plugin, values, fetchPlugin, loadPlugins, setActionNotice, t],
  );

  if (dismissed) {
    return (
      <div className="my-2 px-3 py-2 border border-ok/30 bg-ok/5 text-xs text-ok">
        {t("messagecontent.PluginEnabledInlineNotice", {
          defaultValue: "{{name}} is enabled.",
          name: plugin?.name ?? pluginId,
        })}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic">
        {t("messagecontent.LoadingConfiguration", {
          defaultValue: "Loading {{pluginId}} configuration...",
          pluginId,
        })}
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic">
        {t("messagecontent.PluginNotFound", {
          defaultValue: 'Plugin "{{pluginId}}" not found.',
          pluginId,
        })}
      </div>
    );
  }

  const isEnabled = plugin.enabled;

  return (
    <div className="my-2 border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-hover">
        <div className="flex items-center gap-2 text-xs font-bold text-txt">
          {plugin.icon ? (
            <span className="text-sm">{plugin.icon}</span>
          ) : (
            <span className="text-sm opacity-60">{"\u2699\uFE0F"}</span>
          )}
          <span>
            {t("messagecontent.PluginConfigurationTitle", {
              defaultValue: "{{name}} Configuration",
              name: plugin.name,
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {plugin.configured && (
            <span className="text-2xs text-ok font-medium">
              {t("config-field.Configured")}
            </span>
          )}
          <span
            className={`text-2xs font-medium ${isEnabled ? "text-ok" : "text-muted"}`}
          >
            {isEnabled
              ? t("common.active", {
                  defaultValue: "Active",
                })
              : t("common.inactive", {
                  defaultValue: "Inactive",
                })}
          </span>
        </div>
      </div>

      {/* Form — always shown so user can configure before enabling */}
      {schema && hasConfigurableParams ? (
        <div className="p-3">
          <ConfigRenderer
            schema={schema}
            hints={hints}
            values={mergedValues}
            setKeys={setKeys}
            registry={defaultRegistry}
            pluginId={plugin.id}
            onChange={handleChange}
          />
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-muted italic">
          {t("messagecontent.NoConfigurablePara")}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {schema && hasConfigurableParams && (
          <Button
            variant="default"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40"
            onClick={handleSave}
            disabled={saving || enabling || Object.keys(values).length === 0}
          >
            {saving
              ? t("common.saving", {
                  defaultValue: "Saving...",
                })
              : t("common.save")}
          </Button>
        )}

        {!isEnabled ? (
          <Button
            variant="outline"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs border-ok/50 text-ok bg-ok/5 hover:bg-ok/10 hover:text-ok disabled:opacity-40"
            onClick={() => void handleToggle(true)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Enabling", {
                  defaultValue: "Turning on...",
                })
              : t("messagecontent.EnablePlugin", {
                  defaultValue: "Enable plugin",
                })}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-40"
            onClick={() => void handleToggle(false)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Disabling", {
                  defaultValue: "Turning off...",
                })
              : t("common.disable", {
                  defaultValue: "Disable",
                })}
          </Button>
        )}

        {saved && <span className="text-xs text-ok">{t("common.saved")}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

// ── UiSpec block ────────────────────────────────────────────────────

export function MessageUiSpecBlock({
  spec,
  raw,
}: {
  spec: UiSpec;
  raw: string;
}) {
  const { t, sendActionMessage } = useAppSelectorShallow((s) => ({
    t: s.t,
    sendActionMessage: s.sendActionMessage,
  }));
  const [showRaw, setShowRaw] = useState(false);

  const handleAction = useCallback(
    (action: string, params?: Record<string, unknown>) => {
      // Plugin actions are handled directly via the API instead of
      // being sent back as chat messages.
      if (action === "plugin:save" && params?.pluginId) {
        const pluginId = String(params.pluginId);
        const config: Record<string, string> = {};
        // Collect all config.* state values
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            if (
              key.startsWith("config.") &&
              typeof value === "string" &&
              value.trim()
            ) {
              config[key.slice(7)] = value.trim();
            }
          }
        }
        void client
          .updatePlugin(pluginId, { config })
          .then(() =>
            sendActionMessage(
              `[Plugin ${pluginId} configuration saved successfully]`,
            ),
          )
          .catch((err: unknown) =>
            sendActionMessage(
              `[Failed to save plugin config: ${err instanceof Error ? err.message : "unknown error"}]`,
            ),
          );
        return;
      }
      if (action === "plugin:enable" && params?.pluginId) {
        void client
          .updatePlugin(String(params.pluginId), { enabled: true })
          .then(() =>
            sendActionMessage(
              `[Plugin ${params.pluginId} enabled. Restart required.]`,
            ),
          )
          .catch(() => sendActionMessage(`[Failed to enable plugin]`));
        return;
      }
      if (action === "plugin:test" && params?.pluginId) {
        void sendActionMessage(`[Testing ${params.pluginId} connection...]`);
        return;
      }
      if (action === "plugin:configure" && params?.pluginId) {
        void sendActionMessage(
          `Please show me the configuration form for the ${params.pluginId} plugin`,
        );
        return;
      }
      const paramsStr = params ? ` ${JSON.stringify(params)}` : "";
      void sendActionMessage(`[action:${action}]${paramsStr}`);
    },
    [sendActionMessage],
  );

  return (
    <div className="my-2 border border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-hover">
        <span className="text-2xs font-semibold text-muted uppercase tracking-wider">
          {t("messagecontent.InteractiveUI")}
        </span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-2xs text-txt hover:underline decoration-accent/50 underline-offset-2"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw
            ? t("messagecontent.HideJson", {
                defaultValue: "Hide JSON",
              })
            : t("messagecontent.ViewJson", {
                defaultValue: "View JSON",
              })}
        </Button>
      </div>
      {showRaw && (
        <div className="px-3 py-2 bg-card overflow-x-auto overscroll-x-contain">
          <pre className="text-2xs text-muted font-mono whitespace-pre-wrap break-words m-0">
            {raw}
          </pre>
        </div>
      )}
      <div className="p-3">
        {/*
          A model-emitted UiSpec can be malformed in ways the renderer can't
          fully normalize (wrong-typed array props, unknown shapes). Without a
          boundary here a single bad widget throws past every view boundary to
          the app ROOT error screen — and because the message re-hydrates from
          history, "Try Again"/restart re-crash it, bricking the app. Contain
          any render throw to this one message and offer the raw JSON instead.
        */}
        <ErrorBoundary
          fallback={() => (
            <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted">
              <span className="font-semibold text-destructive">
                Couldn't render this widget.
              </span>{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Hide JSON" : "View JSON"}
              </button>
            </div>
          )}
        >
          <UiRenderer spec={spec} onAction={handleAction} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function SensitiveRequestBlock({
  request,
}: {
  request: NonNullable<ConversationMessage["secretRequest"]>;
}) {
  const [status, setStatus] = useState(request.status);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(request.status);
    setValues({});
    setSaving(false);
    setAuthorizing(false);
    setError(null);
  }, [request]);

  const fields = request.form?.fields ?? [];
  const isRemoteConnect = request.form?.kind === "remote_connect";
  const canCollectSecret =
    status === "pending" &&
    (request.form?.kind === "secret" || isRemoteConnect) &&
    request.delivery?.canCollectValueInCurrentChannel === true &&
    fields.length > 0;
  const canStartOAuth =
    status === "pending" &&
    request.form?.kind === "oauth" &&
    isHttpsAuthorizationUrl(request.form.authorizationUrl);

  const canSubmit = fields.every((field) => {
    if (!field.required) return true;
    return (values[field.name] ?? "").trim().length > 0;
  });

  const tunnel = request.delivery?.tunnel;
  const requestLabel = sensitiveRequestTitleLabel(request.key);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canCollectSecret || !canSubmit) return;
      setSaving(true);
      setError(null);
      try {
        if (isRemoteConnect) {
          // Remote-connect path (first-run): validate the URL and dispatch the
          // hardened CONNECT_EVENT — the App handler connects to the remote
          // agent, adopts it as the active runtime, and finishes onboarding. The
          // values are NEVER written to the secret store. skipConfirm: the user
          // explicitly typed this URL in the trusted onboarding flow.
          let normalized: string;
          try {
            normalized = normalizeRemoteAgentUrl(values.url ?? "");
          } catch (caught) {
            // A typo'd URL must not flip the block to "failed" (which unmounts
            // the form) — surface the message and keep the form editable.
            setError(
              caught instanceof Error
                ? caught.message
                : "Enter a valid remote agent URL.",
            );
            return;
          }
          dispatchAppEvent(CONNECT_EVENT, {
            gatewayUrl: normalized,
            token: values.token?.trim() || undefined,
            completeFirstRun: true,
            skipConfirm: true,
          });
          setValues({});
          setStatus("saved");
          return;
        }
        if (tunnel) {
          // Tunnel path (#10317): route each submitted value to the waiting
          // child via the one-shot CredentialTunnelService. MUTUALLY EXCLUSIVE
          // with updateSecrets — a tunnel-routed value is never written to the
          // long-term agent secret store.
          for (const field of fields) {
            const value = values[field.name];
            if (value != null && value !== "") {
              await client.tunnelCredential({
                credentialScopeId: tunnel.credentialScopeId,
                childSessionId: tunnel.childSessionId,
                key: field.name,
                value,
              });
            }
          }
        } else {
          const secrets: Record<string, string> = {};
          for (const field of fields) {
            const value = values[field.name];
            if (value != null && value !== "") {
              secrets[field.name] = value;
            }
          }
          await client.updateSecrets(secrets);
        }
        setValues({});
        setStatus("saved");
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : tunnel
              ? "Could not submit credential."
              : "Could not save secret.",
        );
        setStatus("failed");
      } finally {
        setSaving(false);
      }
    },
    [canCollectSecret, canSubmit, fields, isRemoteConnect, tunnel, values],
  );

  return (
    <div
      data-testid="sensitive-request"
      className="my-2 border border-border bg-card p-3 text-sm space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 break-words font-medium">{requestLabel}</div>
        <div
          data-testid="sensitive-request-status"
          className="shrink-0 text-xs text-muted"
        >
          {sensitiveRequestStatusLabel(status)}
        </div>
      </div>
      {request.reason && (
        <div className="text-xs text-muted">{request.reason}</div>
      )}
      {request.delivery?.instruction && (
        <div className="text-xs text-muted">{request.delivery.instruction}</div>
      )}
      {canCollectSecret && (
        <form className="space-y-3" onSubmit={handleSubmit}>
          {fields.map((field) => {
            const label = field.label ?? field.name;
            const inputId = `sensitive-request-${field.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const isUpload = field.input === "image" || field.input === "file";
            if (isUpload) {
              const accept =
                field.mimeTypes && field.mimeTypes.length > 0
                  ? field.mimeTypes.join(",")
                  : field.input === "image"
                    ? "image/*"
                    : undefined;
              const hasValue = Boolean(values[field.name]);
              return (
                <label
                  key={field.name}
                  htmlFor={inputId}
                  className="block text-xs space-y-1"
                >
                  <span className="font-medium">{label}</span>
                  <Input
                    id={inputId}
                    aria-label={label}
                    data-testid={`sensitive-request-file-${field.name}`}
                    className="border-border bg-bg px-2 py-1.5 text-sm"
                    type="file"
                    accept={accept}
                    // Mobile: prefer the rear camera for image capture (2FA QR/seed).
                    capture={
                      field.input === "image" ? "environment" : undefined
                    }
                    required={field.required && !hasValue}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (!file) {
                        setValues((previous) => {
                          const next = { ...previous };
                          delete next[field.name];
                          return next;
                        });
                        return;
                      }
                      if (field.maxBytes && file.size > field.maxBytes) {
                        setError(
                          `${label} is too large (max ${Math.round(
                            field.maxBytes / 1024,
                          )} KB).`,
                        );
                        event.currentTarget.value = "";
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => {
                        setError(null);
                        setValues((previous) => ({
                          ...previous,
                          [field.name]: String(reader.result ?? ""),
                        }));
                      };
                      reader.onerror = () =>
                        setError(`Could not read ${label}.`);
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>
              );
            }
            return (
              <label
                key={field.name}
                htmlFor={inputId}
                className="block text-xs space-y-1"
              >
                <span className="font-medium">{label}</span>
                <Input
                  id={inputId}
                  aria-label={label}
                  className="border-border bg-bg px-2 py-1.5 text-sm"
                  type={field.input === "secret" ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: nextValue,
                    }));
                  }}
                  required={field.required}
                />
              </label>
            );
          })}
          <Button
            type="submit"
            size="sm"
            disabled={saving || !canSubmit}
            data-testid="sensitive-request-submit"
          >
            {saving ? "Saving..." : (request.form?.submitLabel ?? "Save")}
          </Button>
        </form>
      )}
      {canStartOAuth && request.form?.kind === "oauth" && (
        <OAuthRequestPanel
          form={request.form}
          authorizing={authorizing}
          onStart={() => {
            const url = request.form?.authorizationUrl;
            // Re-validate at the sink (defense-in-depth): only an https consent
            // URL may reach window.open.
            if (!isHttpsAuthorizationUrl(url)) {
              setError("Invalid authorization URL.");
              return;
            }
            try {
              // SECURITY: we never embed the authorizationUrl in chat text.
              // It is only opened in a popup. We deliberately do NOT pass
              // `noopener` in the features string: per the HTML spec, when
              // `noopener` is set `window.open` always returns null, so we
              // would lose our popup-blocked signal and have to fall back to
              // a guess-and-check heuristic. The consent page is to a
              // trusted provider on a separate origin; `noreferrer` is kept,
              // and we set `popup.opener = null` ourselves immediately after
              // open as a belt-and-suspenders measure. If `window.open`
              // returns null after this, that genuinely is a blocked popup.
              if (typeof window === "undefined") return;
              const popup = window.open(
                url,
                "eliza-oauth",
                "width=520,height=720,noreferrer",
              );
              if (!popup) {
                setError(
                  "Pop-up blocked. Allow pop-ups for this site to continue.",
                );
                return;
              }
              try {
                popup.opener = null;
              } catch {
                // Some browsers throw when reassigning opener cross-origin;
                // `noreferrer` already mitigates this. Swallow.
              }
              setAuthorizing(true);
              setError(null);
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start authorization.",
              );
            }
          }}
        />
      )}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

export function MessagePermissionCard({
  payload,
}: {
  payload: PermissionCardPayload;
}) {
  const { sendActionMessage } = useAppSelectorShallow((s) => ({
    sendActionMessage: s.sendActionMessage,
  }));

  const permissionRegistry = useMemo(
    () =>
      isNative && !isDesktopPlatform()
        ? createMobileSignalsPermissionsRegistry(undefined, client)
        : createClientPermissionsRegistry(client),
    [],
  );

  const handlePermissionFallback = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:use_fallback feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  const handlePermissionGranted = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:granted feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  return renderPermissionCardFromPayload(payload, {
    registry: permissionRegistry,
    onOpenSettings: async (permission) => {
      if (isNative && !isDesktopPlatform()) {
        await openMobilePermissionSettings(permission);
        return;
      }
      await client.openPermissionSettings(permission);
    },
    onFallback: ({ feature, permission }) =>
      handlePermissionFallback(feature, permission),
    onGranted: () =>
      handlePermissionGranted(payload.feature, payload.permission),
  });
}

function OAuthRequestPanel({
  form,
  authorizing,
  onStart,
}: {
  form: NonNullable<NonNullable<ConversationMessage["secretRequest"]>["form"]>;
  authorizing: boolean;
  onStart: () => void;
}) {
  const provider = form.provider ?? "provider";
  const label = form.submitLabel ?? `Connect ${provider}`;
  return (
    <div data-testid="sensitive-request-oauth" className="space-y-2">
      {form.scopes && form.scopes.length > 0 && (
        <div className="text-xs text-muted">
          Scopes: {form.scopes.join(", ")}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        onClick={onStart}
        disabled={authorizing}
        data-testid="sensitive-request-oauth-start"
      >
        {authorizing ? "Authorizing..." : label}
      </Button>
      <div className="text-xs text-muted">
        Authorization happens in a separate window. The token is stored securely
        and is never shown in chat.
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export function MessageContent({
  message,
  analysisMode = false,
}: MessageContentProps) {
  useRenderGuard(`MessageContent:${message.id ?? "unknown"}`);
  const { sendActionMessage, setTab, handleChatRetry } = useAppSelectorShallow(
    (s) => ({
      sendActionMessage: s.sendActionMessage,
      setTab: s.setTab,
      handleChatRetry: s.handleChatRetry,
    }),
  );
  // Composer prefill for followup `prompt` chips. Outside the chat provider,
  // `useChatComposer` returns an inert setter, so this is safe everywhere.
  const { setChatInput } = useChatComposer();
  const [localDownloadState, setLocalDownloadState] = useState<
    "idle" | "busy" | "queued" | "failed"
  >("idle");
  const [localDownloadError, setLocalDownloadError] = useState<string | null>(
    null,
  );

  // Parse segments — memoize to avoid re-parsing on every render
  const segments = useMemo(() => {
    try {
      return parseSegments(message.text, analysisMode);
    } catch {
      // If parsing fails, just show plain text
      return [{ kind: "text" as const, text: message.text }];
    }
  }, [message.text, analysisMode]);

  // Handlers handed to every inline widget at render: the SAME shared contract
  // the overlay surface (InlineWidgetText) uses, so a CHOICE pick / FOLLOWUPS
  // chip / FORM submit behaves identically on both. Self-contained widgets (the
  // task card) ignore them; interactive ones drive the chat surface.
  const inlineWidgetCtx = useInlineWidgetContext(
    sendActionMessage,
    setChatInput,
  );

  const handleOpenSettings = useCallback(() => {
    setTab?.("settings");
  }, [setTab]);

  const handleDownloadDefaultLocalModel = useCallback(async () => {
    const modelId = message.localInference?.modelId;
    if (!modelId) {
      handleOpenSettings();
      return;
    }
    setLocalDownloadState("busy");
    setLocalDownloadError(null);
    try {
      await client.startLocalInferenceDownload(modelId);
      setLocalDownloadState("queued");
    } catch (error) {
      setLocalDownloadError(
        error instanceof Error ? error.message : "Failed to start download",
      );
      setLocalDownloadState("failed");
    }
  }, [handleOpenSettings, message.localInference?.modelId]);

  if (message.secretRequest) {
    return <SensitiveRequestBlock request={message.secretRequest} />;
  }

  if (message.accountConnect) {
    return <AccountConnectBlock request={message.accountConnect} />;
  }

  if (
    message.localInference &&
    message.localInference.status !== "ready" &&
    message.localInference.status !== "routing"
  ) {
    const status = message.localInference.status;
    const downloading = status === "downloading" || status === "loading";
    const canStartDownload = Boolean(message.localInference.modelId);
    return (
      <div className="rounded-sm border border-warn/30 bg-warn/5 p-3 text-sm">
        <div className="mb-1 font-medium">
          {downloading
            ? "Local model download in progress"
            : "Local model required"}
        </div>
        <div className="mb-2 whitespace-pre-wrap text-muted">
          {message.text}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleDownloadDefaultLocalModel}
            disabled={downloading || localDownloadState === "busy"}
          >
            {downloading
              ? "Downloading"
              : localDownloadState === "busy"
                ? "Starting..."
                : localDownloadState === "queued"
                  ? "Download queued"
                  : "Download default model"}
          </Button>
          {!canStartDownload ? (
            <Button type="button" size="sm" onClick={handleOpenSettings}>
              Open Local Models
            </Button>
          ) : null}
        </div>
        {localDownloadError ? (
          <div className="mt-2 text-xs text-danger">{localDownloadError}</div>
        ) : null}
      </div>
    );
  }

  // The server flags failed assistant turns with `failureKind`. For
  // `no_provider` specifically the user can't make progress without
  // wiring up a provider, so render a structured gate (banner + CTA)
  // instead of the fallback text — clicking jumps to Settings where
  // ProviderSwitcher lives. Other failure kinds (insufficient_credits,
  // provider_issue) still render as normal text bubbles; the user has
  // separate, clearer in-product affordances for those (Cloud billing
  // banner, retry).
  if (message.failureKind === "no_provider") {
    return (
      <div className="border border-warn/30 bg-warn/5 rounded-sm p-3 text-sm">
        <div className="font-medium mb-1">Connect a provider to chat</div>
        <div className="text-muted whitespace-pre-wrap mb-2">
          {message.text}
        </div>
        <Button type="button" size="sm" onClick={handleOpenSettings}>
          Open Settings
        </Button>
      </div>
    );
  }

  // Transient server failures (the agent was rate-limited or the provider had a
  // hiccup) render the graceful message plus a one-tap Retry that resends the
  // preceding user turn, so a stalled turn isn't a dead end the user has to
  // retype. `no_provider`/`insufficient_credits` are excluded — a retry can't
  // fix those (they have their own Settings / billing affordances).
  if (
    message.failureKind === "rate_limited" ||
    message.failureKind === "provider_issue"
  ) {
    return (
      <div className="border border-warn/30 bg-warn/5 rounded-sm p-3 text-sm">
        <div className="text-muted whitespace-pre-wrap mb-2">
          {message.text}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            if (message.id) handleChatRetry(message.id);
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // Fast path: single plain-text segment (most messages)
  if (segments.length === 1 && segments[0].kind === "text") {
    return (
      <MessageTextBody
        text={segments[0].text}
        boldSlashCommand={message.role === "user"}
      />
    );
  }

  return (
    <div>
      {message.role === "assistant" && message.reasoning?.trim() ? (
        <ThinkingBlock reasoning={message.reasoning} />
      ) : null}
      {(() => {
        const keyCounts = new Map<string, number>();
        const nextKey = (base: string) => {
          const nextCount = (keyCounts.get(base) ?? 0) + 1;
          keyCounts.set(base, nextCount);
          return `${base}:${nextCount}`;
        };

        return segments.map((seg) => {
          const baseKey =
            seg.kind === "text"
              ? `text:${seg.text.slice(0, 80)}`
              : seg.kind === "code"
                ? `code:${seg.code.slice(0, 80)}`
                : seg.kind === "config"
                  ? `config:${seg.pluginId}`
                  : seg.kind === "widget"
                    ? (getInlineWidget(seg.widgetKind)?.keyFor?.(seg.data) ??
                      `widget:${seg.widgetKind}`)
                    : seg.kind === "permission"
                      ? `permission:${seg.payload.feature}`
                      : seg.kind === "analysis-xml"
                        ? `analysis:${seg.tag}`
                        : `ui:${seg.raw.slice(0, 80)}`;
          const segmentKey = nextKey(baseKey);

          switch (seg.kind) {
            case "text":
              return (
                <MessageTextBody
                  key={segmentKey}
                  text={seg.text}
                  boldSlashCommand={message.role === "user"}
                />
              );
            case "code":
              return (
                <CodeBlock
                  key={segmentKey}
                  className="my-2"
                  value={seg.code}
                  wrap
                  copyable
                  data-testid="code-block"
                  {...(seg.lang ? { "data-lang": seg.lang } : {})}
                />
              );
            case "analysis-xml":
              return (
                <div
                  key={segmentKey}
                  className="my-2 border border-accent/20 rounded-sm bg-accent/5 overflow-hidden"
                >
                  <div className="bg-accent/10 px-3 py-1 text-xs font-mono font-bold text-accent uppercase tracking-wider">
                    &lt;{seg.tag}&gt;
                  </div>
                  <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-muted m-0 overflow-x-auto overscroll-x-contain">
                    {seg.content.trim()}
                  </pre>
                </div>
              );
            case "config":
              if (!isSafeNormalizedPluginId(normalizePluginId(seg.pluginId))) {
                return null;
              }
              return (
                <InlinePluginConfig key={segmentKey} pluginId={seg.pluginId} />
              );
            case "ui-spec":
              return (
                <MessageUiSpecBlock
                  key={segmentKey}
                  spec={seg.spec}
                  raw={seg.raw}
                />
              );
            case "widget": {
              const widget = getInlineWidget(seg.widgetKind);
              return widget
                ? widget.render(seg.data, inlineWidgetCtx, segmentKey)
                : null;
            }
            case "permission":
              return (
                <MessagePermissionCard key={segmentKey} payload={seg.payload} />
              );
            default:
              return null;
          }
        });
      })()}
      {message.attachments?.length ? (
        <MessageAttachments attachments={message.attachments} />
      ) : null}
      {analysisMode && message.actionName && (
        <div className="my-2 overflow-hidden rounded-sm border border-accent/20 bg-accent/5">
          <div className="bg-accent/10 px-3 py-1 text-xs font-mono font-bold text-accent uppercase tracking-wider">
            ACTION TAKEN
          </div>
          <div className="px-3 py-2 text-xs font-mono text-muted space-y-1">
            {message.actionName}
          </div>
        </div>
      )}
      {analysisMode &&
        message.actionCallbackHistory &&
        message.actionCallbackHistory.length > 0 && (
          <div className="my-2 overflow-hidden rounded-sm border border-border/60 bg-surface/70">
            <div className="bg-bg-accent px-3 py-1 text-xs font-mono font-bold text-muted-strong uppercase tracking-wider">
              ACTION CALLBACK HISTORY
            </div>
            <div className="px-3 py-2 text-xs font-mono text-muted space-y-1">
              {(() => {
                const occurrence = new Map<string, number>();
                return message.actionCallbackHistory.map((log) => {
                  const n = occurrence.get(log) ?? 0;
                  occurrence.set(log, n + 1);
                  return (
                    <div
                      key={`${message.id}:action-callback:${n}:${log}`}
                      className="break-words border-b border-border/40 pb-1 last:border-0 last:pb-0"
                    >
                      {log}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
    </div>
  );
}
