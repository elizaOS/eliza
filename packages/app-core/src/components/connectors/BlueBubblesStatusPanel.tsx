import { Button, PagePanel } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";

type BlueBubblesStatus = Awaited<
  ReturnType<typeof client.getBlueBubblesStatus>
>;

function resolveWebhookTarget(status: BlueBubblesStatus | null): string | null {
  if (!status?.webhookPath) {
    return null;
  }

  const baseUrl = client.getBaseUrl();
  if (typeof baseUrl === "string" && /^https?:\/\//.test(baseUrl)) {
    return new URL(status.webhookPath, `${baseUrl}/`).toString();
  }

  if (
    typeof window !== "undefined" &&
    (window.location.protocol === "http:" ||
      window.location.protocol === "https:")
  ) {
    return new URL(status.webhookPath, window.location.origin).toString();
  }

  return status.webhookPath;
}

export function BlueBubblesStatusPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<BlueBubblesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.getBlueBubblesStatus());
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return client.onWsEvent("ws-reconnected", () => {
      void refresh();
    });
  }, [refresh]);
  const webhookTarget = resolveWebhookTarget(status);

  return (
    <PagePanel.Notice
      tone={error ? "danger" : status?.connected ? "accent" : "default"}
      className="mt-4"
      actions={
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
        >
          {loading
            ? t("common.loading", { defaultValue: "Loading…" })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      }
    >
      <div className="space-y-2 text-xs">
        <div className="font-semibold text-txt">
          {status?.connected
            ? t("pluginsview.BlueBubblesConnected", {
                defaultValue: "BlueBubbles is connected.",
              })
            : t("pluginsview.BlueBubblesNotConnected", {
                defaultValue:
                  "BlueBubbles is not connected yet. Save the server URL and password above, then refresh.",
              })}
        </div>
        {error ? <div className="text-danger">{error}</div> : null}
        {!error && status?.reason ? (
          <div className="text-muted">{status.reason}</div>
        ) : null}
        {webhookTarget ? (
          <div className="space-y-1">
            <div className="font-medium text-txt">
              {t("pluginsview.BlueBubblesWebhookTarget", {
                defaultValue: "Webhook target",
              })}
            </div>
            <code className="block break-all rounded-lg border border-border/40 bg-bg/70 px-3 py-2 text-xs-tight text-muted-strong">
              {webhookTarget}
            </code>
          </div>
        ) : null}
        <div className="text-muted">
          {t("pluginsview.BlueBubblesWebhookHint", {
            defaultValue:
              "Point your BlueBubbles webhook at the app API host so new iMessage events stream into the inbox.",
          })}
        </div>
      </div>
    </PagePanel.Notice>
  );
}
