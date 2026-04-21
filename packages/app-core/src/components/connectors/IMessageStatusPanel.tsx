import { Button, PagePanel } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";

type IMessageStatus = {
  available: boolean;
  connected: boolean;
  reason?: string;
};

export function IMessageStatusPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.fetch("/api/imessage/status");
      setStatus(res as IMessageStatus);
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
            ? t("common.loading", { defaultValue: "Loading\u2026" })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      }
    >
      <div className="space-y-2 text-xs">
        <div className="font-semibold text-txt">
          {status?.connected
            ? t("pluginsview.IMessageConnected", {
                defaultValue:
                  "iMessage is connected. Messages are being read from the local database.",
              })
            : t("pluginsview.IMessageNotConnected", {
                defaultValue:
                  "iMessage is not connected. Set the CLI path above and ensure Full Disk Access is granted to your terminal.",
              })}
        </div>
        {error ? <div className="text-danger">{error}</div> : null}
        {!error && status?.reason ? (
          <div className="text-muted">{status.reason}</div>
        ) : null}
        <div className="text-muted">
          {t("pluginsview.IMessagePermissionHint", {
            defaultValue:
              "iMessage reads ~/Library/Messages/chat.db directly. Grant Full Disk Access in System Settings > Privacy & Security for the process running the app.",
          })}
        </div>
      </div>
    </PagePanel.Notice>
  );
}
