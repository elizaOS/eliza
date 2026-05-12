import { Button } from "../ui/button";
import { PagePanel } from "../composites/page-panel";
import { useCallback, useEffect, useState } from "react";
import { client, type IMessageApiStatus } from "../../api";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";

export function IMessageStatusPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<IMessageApiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const permissionAction =
    status?.permissionAction?.type === "full_disk_access"
      ? status.permissionAction
      : null;
  const isSendOnly = status?.sendOnly === true;
  const canReadMessages =
    status?.connected === true && status?.chatDbAvailable === true;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.getIMessageStatus());
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
      tone={
        error
          ? "danger"
          : permissionAction || isSendOnly
            ? "warning"
            : status?.connected
              ? "accent"
              : "default"
      }
      className="mt-4"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {permissionAction ? (
            <Button
              variant="default"
              size="sm"
              className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
              onClick={() => {
                void openExternalUrl(permissionAction.url);
              }}
            >
              {t("pluginsview.IMessageOpenFullDiskAccess", {
                defaultValue: permissionAction.label,
              })}
            </Button>
          ) : null}
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
        </div>
      }
    >
      <div className="space-y-2 text-xs">
        <div className="font-semibold text-txt">
          {canReadMessages
            ? t("pluginsview.IMessageConnected", {
                defaultValue:
                  "iMessage is connected. Messages are being read from the local database.",
              })
            : isSendOnly
              ? t("pluginsview.IMessageSendOnly", {
                  defaultValue:
                    "iMessage can send, but Eliza cannot read local messages until Full Disk Access is granted.",
                })
              : t("pluginsview.IMessageNotConnected", {
                  defaultValue:
                    "iMessage is not connected. Eliza uses the native macOS Messages bridge on this machine.",
                })}
        </div>
        {error ? <div className="text-danger">{error}</div> : null}
        {!error && status?.reason ? (
          <div className="text-muted">{status.reason}</div>
        ) : null}
        {status?.chatDbPath ? (
          <div className="text-muted">Database: {status.chatDbPath}</div>
        ) : null}
        {status?.bridgeType ? (
          <div className="text-muted">Bridge: {status.bridgeType}</div>
        ) : null}
        {permissionAction ? (
          <ol className="list-decimal space-y-1 pl-4 text-muted">
            {permissionAction.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        ) : null}
        <div className="text-muted">
          {t("pluginsview.IMessagePermissionHint", {
            defaultValue:
              "iMessage reads ~/Library/Messages/chat.db directly. Full Disk Access must be granted to Eliza Desktop, or to Terminal/iTerm when running Eliza from a shell.",
          })}
        </div>
      </div>
    </PagePanel.Notice>
  );
}
