/**
 * Status panel for the BlueBubbles iMessage bridge, rendered in the connector
 * setup surface. Fetches bridge status via `client.getBlueBubblesStatus` and
 * surfaces the resolved webhook URL the user pastes into their BlueBubbles
 * server, resolving a relative webhook path against the API base URL or the
 * current window origin.
 */

import { useEffect } from "react";
import { client } from "../../api";
import { useFetchData } from "../../hooks";
import { useAppSelector } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";

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
  const t = useAppSelector((s) => s.t);
  const fetchState = useFetchData<BlueBubblesStatus>(
    (_signal) => client.getBlueBubblesStatus(),
    [],
  );

  const status = fetchState.status === "success" ? fetchState.data : null;
  const loading = fetchState.status === "loading";
  const error = fetchState.status === "error" ? fetchState.error.message : null;
  const refresh = fetchState.refetch;

  useEffect(() => {
    return client.onWsEvent("ws-reconnected", () => {
      refresh();
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
          className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
          onClick={refresh}
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
            <code className="block break-all rounded-sm border border-border/40 bg-bg/70 px-3 py-2 text-xs-tight text-muted-strong">
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
