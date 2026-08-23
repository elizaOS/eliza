/**
 * ConnectorCardWidget — the compact branded in-chat connector card rendered for
 * `[CONNECTOR:<pluginId>]` markers: brand icon, connector name, one-line
 * description, and a single context-aware CTA. When the connector declares an
 * OAuth mode the CTA is "Authorize" (starts the connector-account OAuth flow
 * and opens the consent URL); otherwise it is "Add token", which reveals a
 * masked secret form that saves through `PUT /api/secrets` — the value never
 * enters the transcript. Connected connectors render a passive "Connected"
 * state instead of a CTA.
 *
 * The card is deliberately NOT the full configuration surface — `[CONFIG:…]` /
 * the Settings connectors page own that. It is an entry point sized for the
 * "connect gmail" chat flow, self-contained like `InlinePluginConfig`: all
 * state is internal, the only prop is a primitive plugin id, so `memo` bails
 * transcript-parent re-renders out before this subtree.
 */

import { Puzzle, ShieldCheck } from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../../api/client";
import type { PluginInfo } from "../../../api/client-types-config";
import { cn } from "../../../lib/utils";
import { useAppSelectorShallow } from "../../../state";
import { getBrandIcon } from "../../conversations/brand-icons";
import { iconImageSource, resolveIcon } from "../../pages/plugin-list-utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { connectorWidgetModes } from "../inline-connector-modes";
import {
  isSafeNormalizedPluginId,
  normalizePluginId,
} from "../message-parser-helpers";

/**
 * An OAuth authUrl is server-supplied data flowing into window.open — https
 * only, same fail-closed contract as MessageContent's isHttpsAuthorizationUrl.
 */
function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    // error-policy:J3 untrusted URL from an API response — fail closed
    return false;
  }
}

function ConnectorBrandIcon({
  plugin,
  className,
}: {
  plugin: PluginInfo;
  className?: string;
}) {
  const Brand = getBrandIcon(plugin.id);
  if (Brand) return <Brand className={className} />;
  const icon = resolveIcon(plugin);
  const imageSrc = typeof icon === "string" ? iconImageSource(icon) : null;
  if (imageSrc) {
    return (
      <img src={imageSrc} alt="" className={cn(className, "object-contain")} />
    );
  }
  if (icon && typeof icon !== "string") {
    const IconComponent = icon;
    return <IconComponent className={className} aria-hidden />;
  }
  return <Puzzle className={className} aria-hidden />;
}

/** Poll cadence/budget for the post-authorize "did we connect?" refresh. */
const CONNECT_POLL_INTERVAL_MS = 3000;
const CONNECT_POLL_BUDGET_MS = 120_000;

export const ConnectorCardWidget = memo(function ConnectorCardWidget({
  pluginId: rawPluginId,
}: {
  pluginId: string;
}) {
  const pluginId = normalizePluginId(rawPluginId);
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizing, setAuthorizing] = useState(false);
  const [tokenFormOpen, setTokenFormOpen] = useState(false);
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t, elizaCloudConnected, loadPlugins } = useAppSelectorShallow(
    (s) => ({
      t: s.t,
      elizaCloudConnected: s.elizaCloudConnected,
      loadPlugins: s.loadPlugins,
    }),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const fetchPlugin = useCallback(async () => {
    try {
      const { plugins } = await client.getPlugins();
      if (!mountedRef.current) return;
      setPlugin(plugins.find((p) => p.id === pluginId) ?? null);
    } catch {
      // error-policy:J4 load failure renders the card's error state
      if (mountedRef.current) {
        setError(
          t("connectorcard.LoadFailed", {
            defaultValue: "Couldn't load connector info.",
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

  const connected = Boolean(plugin?.enabled && plugin?.configured);

  const modes = useMemo(
    () => connectorWidgetModes(pluginId, { elizaCloudConnected }),
    [pluginId, elizaCloudConnected],
  );
  const hasOAuthMode = useMemo(
    () => modes.some((mode) => mode.kind === "oauth"),
    [modes],
  );

  // The token CTA collects only the connector's required sensitive params
  // (bot token / API key). Non-sensitive or optional setup stays on the full
  // [CONFIG:…] card and the Settings page.
  const tokenFields = useMemo(
    () =>
      (plugin?.parameters ?? []).filter(
        (param) => param.sensitive && param.required,
      ),
    [plugin],
  );

  useEffect(() => {
    if (connected && pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      setAuthorizing(false);
    }
  }, [connected]);

  const beginConnectPolling = useCallback(() => {
    const startedAt = Date.now();
    const tick = async () => {
      await fetchPlugin();
      if (!mountedRef.current) return;
      if (Date.now() - startedAt >= CONNECT_POLL_BUDGET_MS) {
        setAuthorizing(false);
        return;
      }
      pollTimerRef.current = setTimeout(
        () => void tick(),
        CONNECT_POLL_INTERVAL_MS,
      );
    };
    pollTimerRef.current = setTimeout(
      () => void tick(),
      CONNECT_POLL_INTERVAL_MS,
    );
  }, [fetchPlugin]);

  const handleAuthorize = useCallback(async () => {
    setAuthorizing(true);
    setError(null);
    try {
      const result = await client.startConnectorAccountOAuth(
        pluginId,
        pluginId,
        {},
      );
      if (result.ok !== true) {
        throw new Error(
          result.error?.trim() ||
            t("connectorcard.AuthorizeRejected", {
              defaultValue: "The connector could not start authorization.",
            }),
        );
      }
      if (!isHttpsUrl(result.authUrl)) {
        throw new Error(
          result.error ??
            t("connectorcard.NoAuthUrl", {
              defaultValue:
                "The connector did not return an authorization link.",
            }),
        );
      }
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
      beginConnectPolling();
    } catch (caught) {
      // error-policy:J4 authorize failure renders the card's error state
      if (mountedRef.current) {
        setAuthorizing(false);
        setError(
          caught instanceof Error
            ? caught.message
            : t("connectorcard.AuthorizeFailed", {
                defaultValue: "Couldn't start authorization.",
              }),
        );
      }
    }
  }, [pluginId, beginConnectPolling, t]);

  const canSubmitToken = tokenFields.every(
    (field) => (tokenValues[field.key] ?? "").trim().length > 0,
  );

  const handleTokenSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmitToken || tokenFields.length === 0) return;
      setSaving(true);
      setError(null);
      try {
        const secrets: Record<string, string> = {};
        for (const field of tokenFields) {
          const value = tokenValues[field.key];
          if (value != null && value !== "") secrets[field.key] = value;
        }
        const secretResult = await client.updateSecrets(secrets);
        if (secretResult.ok !== true) {
          throw new Error(
            t("connectorcard.SecretSaveRejected", {
              defaultValue: "The token could not be saved. Try again.",
            }),
          );
        }
        const missingSecretKeys = Object.keys(secrets).filter(
          (key) => !secretResult.updated.includes(key),
        );
        if (missingSecretKeys.length > 0) {
          throw new Error(
            t("connectorcard.SecretSaveUnconfirmed", {
              defaultValue:
                "The agent did not confirm saving every required token. Try again.",
            }),
          );
        }

        const enableResult = await client.updatePlugin(pluginId, {
          enabled: true,
        });
        if (enableResult.ok !== true) {
          const detail =
            enableResult.error?.trim() || enableResult.message?.trim();
          throw new Error(
            t("connectorcard.EnableRejectedAfterSave", {
              defaultValue:
                "The token was saved, but the connector could not be enabled{{detail}}",
              detail: detail ? `: ${detail}` : ". Try again.",
            }),
          );
        }

        if (mountedRef.current) {
          setTokenValues({});
          setTokenFormOpen(false);
          // Optimistic connect; the refetch below reconciles with the server.
          setPlugin((prev) =>
            prev ? { ...prev, enabled: true, configured: true } : prev,
          );
        }
        try {
          await loadPlugins();
        } catch {
          // error-policy:J4 both mutations succeeded, but global status refresh
          // failed; keep the successful local state and make reconciliation visible.
          if (mountedRef.current) {
            setError(
              t("connectorcard.RefreshFailedAfterSave", {
                defaultValue:
                  "Connected, but the connector list could not be refreshed.",
              }),
            );
          }
        }
        pollTimerRef.current = setTimeout(
          () => void fetchPlugin(),
          CONNECT_POLL_INTERVAL_MS,
        );
      } catch (caught) {
        // error-policy:J4 save failure renders the card's error state
        if (mountedRef.current) {
          setError(
            caught instanceof Error
              ? caught.message
              : t("connectorcard.SaveFailed", {
                  defaultValue: "Couldn't save the token.",
                }),
          );
        }
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [
      canSubmitToken,
      tokenFields,
      tokenValues,
      pluginId,
      loadPlugins,
      fetchPlugin,
      t,
    ],
  );

  if (!isSafeNormalizedPluginId(pluginId)) return null;

  if (loading) {
    return (
      <div
        className="my-2 py-2 text-xs text-muted italic"
        data-testid="connector-card-loading"
      >
        {t("connectorcard.Loading", {
          defaultValue: "Looking up {{pluginId}}...",
          pluginId,
        })}
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="my-2 py-2 text-xs text-muted italic">
        {t("connectorcard.NotFound", {
          defaultValue: 'Connector "{{pluginId}}" not found.',
          pluginId,
        })}
      </div>
    );
  }

  return (
    <div
      data-testid="connector-card"
      className="my-2 rounded-sm border border-border/50 bg-card/40 px-3 py-2.5 text-sm"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-bg/60">
          <ConnectorBrandIcon plugin={plugin} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{plugin.name}</div>
          <div className="truncate text-xs text-muted">
            {plugin.description}
          </div>
        </div>
        {connected ? (
          <div
            className="shrink-0 text-xs font-medium text-ok"
            data-testid="connector-card-connected"
          >
            {t("connectorcard.Connected", { defaultValue: "Connected" })}
          </div>
        ) : hasOAuthMode ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void handleAuthorize()}
            disabled={authorizing}
            data-testid="connector-card-authorize"
          >
            {authorizing
              ? t("connectorcard.Authorizing", {
                  defaultValue: "Waiting...",
                })
              : t("connectorcard.Authorize", { defaultValue: "Authorize" })}
          </Button>
        ) : tokenFields.length > 0 ? (
          <Button
            type="button"
            size="sm"
            onClick={() => setTokenFormOpen((open) => !open)}
            data-testid="connector-card-add-token"
          >
            {t("connectorcard.AddToken", { defaultValue: "Add token" })}
          </Button>
        ) : null}
      </div>
      {tokenFormOpen && !connected && tokenFields.length > 0 && (
        <form
          className="mt-3 space-y-3 border-t border-border/40 pt-3"
          onSubmit={handleTokenSubmit}
          data-testid="connector-card-token-form"
        >
          <div className="text-xs text-muted">
            {t("connectorcard.MaskedInputNote", {
              defaultValue: "Masked input. It never lands in the transcript.",
            })}
          </div>
          {tokenFields.map((field) => {
            const inputId = `connector-card-${field.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return (
              <label
                key={field.key}
                htmlFor={inputId}
                className="block text-xs space-y-1"
              >
                <span className="font-medium">{field.key}</span>
                <Input
                  id={inputId}
                  aria-label={field.key}
                  className="border-border bg-bg px-2 py-1.5 text-sm"
                  type="password"
                  value={tokenValues[field.key] ?? ""}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setTokenValues((previous) => ({
                      ...previous,
                      [field.key]: nextValue,
                    }));
                  }}
                  required
                />
              </label>
            );
          })}
          <Button
            type="submit"
            size="sm"
            disabled={saving || !canSubmitToken}
            data-testid="connector-card-token-submit"
          >
            {saving
              ? t("connectorcard.Saving", { defaultValue: "Saving..." })
              : t("connectorcard.SaveSecurely", {
                  defaultValue: "Save securely",
                })}
          </Button>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("connectorcard.StorageNote", {
              defaultValue:
                "Sent directly to the agent — never posted to chat.",
            })}
          </div>
        </form>
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
    </div>
  );
});
