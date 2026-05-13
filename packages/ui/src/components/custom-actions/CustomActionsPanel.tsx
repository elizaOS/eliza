import type { CustomActionDef } from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api/client";
import { useApp } from "../../state/useApp";
import { confirmDesktopAction } from "../../utils/desktop-dialogs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

interface CustomActionsPanelProps {
  open: boolean;
  onClose: () => void;
  onOpenEditor: (action?: CustomActionDef | null) => void;
}

const HANDLER_TYPE_COLORS: Record<string, string> = {
  http: "bg-status-info-bg text-status-info",
  shell: "bg-status-success-bg text-status-success",
  code: "bg-purple-500/20 text-purple-400",
};

function handlerTypeLabel(
  type: string,
  t: (key: string, options?: Record<string, string | number>) => string,
): string {
  switch (type) {
    case "http":
      return t("customactionspanel.HandlerTypeHttp", {
        defaultValue: "HTTP",
      });
    case "shell":
      return t("customactionspanel.HandlerTypeShell", {
        defaultValue: "Shell",
      });
    case "code":
      return t("customactionspanel.HandlerTypeCode", {
        defaultValue: "Code",
      });
    default:
      return type;
  }
}

export function CustomActionsPanel({
  open,
  onClose,
  onOpenEditor,
}: CustomActionsPanelProps) {
  const { t } = useApp();
  const [actions, setActions] = useState<CustomActionDef[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  const loadActions = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const result = await client.listCustomActions();
      setActions(result || []);
    } catch (err) {
      console.error("Failed to load custom actions:", err);
      setError(
        t("customactionspanel.LoadFailed", {
          defaultValue: "Couldn't load custom actions. Try again.",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      void loadActions();
    }
  }, [open, loadActions]);

  const filteredActions = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();
    if (!searchTerm) return actions;

    return actions.filter((action) => {
      const hasName = action.name.toLowerCase().includes(searchTerm);
      const hasDescription =
        typeof action.description === "string" &&
        action.description.toLowerCase().includes(searchTerm);
      const hasAlias = (action.similes ?? []).some((alias) =>
        alias.toLowerCase().includes(searchTerm),
      );
      return hasName || hasDescription || hasAlias;
    });
  }, [actions, search]);

  const enabledCount = useMemo(
    () => actions.filter((action) => action.enabled).length,
    [actions],
  );
  const actionSummary = t("customactionspanel.ActionSummary", {
    defaultValue: "{{actionCount}} total · {{enabledCount}} enabled",
    actionCount: actions.length,
    enabledCount,
  });
  const formatParameterCount = useCallback(
    (count: number) => {
      return count === 1
        ? t("customactionsview.ParameterCountOne", {
            defaultValue: "{{count}} parameter",
            count,
          })
        : t("customactionsview.ParameterCountOther", {
            defaultValue: "{{count}} parameters",
            count,
          });
    },
    [t],
  );
  const formatAliasCount = useCallback(
    (count: number) => {
      return count === 1
        ? t("customactionspanel.AliasCountOne", {
            defaultValue: "{{count}} alias",
            count,
          })
        : t("customactionspanel.AliasCountOther", {
            defaultValue: "{{count}} aliases",
            count,
          });
    },
    [t],
  );

  const handleToggleEnabled = async (action: CustomActionDef) => {
    try {
      const next = !action.enabled;
      await client.updateCustomAction(action.id, {
        enabled: next,
      });
      setActions((prev) =>
        prev.map((item) =>
          item.id === action.id
            ? {
                ...item,
                enabled: next,
              }
            : item,
        ),
      );
    } catch (err) {
      console.error("Failed to toggle action:", err);
      setError(
        t("customactionspanel.UpdateFailed", {
          defaultValue: "Couldn't update this action. Try again.",
        }),
      );
    }
  };

  const handleDelete = async (action: CustomActionDef) => {
    const confirmed = await confirmDesktopAction({
      title: t("customactionsview.DeleteCustomActionTitle"),
      message: t("customactionsview.DeleteCustomActionMessage", {
        name: action.name,
      }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) {
      return;
    }

    try {
      await client.deleteCustomAction(action.id);
      setActions((prev) => prev.filter((item) => item.id !== action.id));
    } catch (err) {
      console.error("Failed to delete action:", err);
      setError(
        t("customactionspanel.DeleteFailed", {
          defaultValue: "Couldn't delete this action. Try again.",
        }),
      );
    }
  };

  const handleEdit = (action: CustomActionDef) => {
    onOpenEditor(action);
  };

  const handleCreate = () => {
    onOpenEditor(null);
  };

  return (
    <div
      className={`bg-card flex flex-col transition-all duration-200 ${
        open ? "w-80" : "w-0 overflow-hidden"
      }`}
    >
      {open && (
        <>
          {/* Header */}
          <div className="flex items-start justify-between p-4">
            <div>
              <h2 className="text-sm font-semibold text-txt">
                {t("customactionsview.CustomActions")}
              </h2>
              <p className="text-xs text-muted mt-0.5">{actionSummary}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-muted hover:text-txt h-7 w-7"
              aria-label={t("aria.closePanel")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <title>{t("aria.closePanel")}</title>
                <path d="M12 4L4 12M4 4l8 8" />
              </svg>
            </Button>
          </div>

          <div className="space-y-3 p-3">
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              className="w-full px-3 py-2 h-9 text-sm font-medium shadow-sm"
            >
              {t("customactionspanel.NewCustomAction")}
            </Button>

            <div className="relative">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("customactionspanel.SearchByNameDesc")}
                className="w-full h-8 bg-surface text-xs placeholder:text-muted/50 shadow-sm focus-visible:ring-1 focus-visible:ring-accent"
              />
            </div>

            {error && (
              <div className="text-xs text-danger bg-danger/10 border border-danger/30 px-2 py-1 rounded">
                {error}
              </div>
            )}
          </div>

          {/* Action List */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading ? (
              <div className="text-center text-muted text-xs py-8">
                {t("customactionspanel.LoadingYourActions")}
              </div>
            ) : filteredActions.length === 0 ? (
              <div className="text-center text-muted text-xs py-8">
                {search
                  ? t("customactionspanel.NoActionsMatchSearch", {
                      defaultValue: "Nothing matches that search.",
                    })
                  : t("customactionspanel.NoActionsYet", {
                      defaultValue:
                        "No custom actions yet. Make one to get started.",
                    })}
              </div>
            ) : (
              filteredActions.map((action) => (
                <div
                  key={action.id}
                  className="border border-border bg-surface rounded p-2 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-xs text-txt truncate">
                        {action.name}
                      </div>
                      <p className="text-2xs text-muted mt-0.5">
                        {formatParameterCount(action.parameters?.length || 0)}
                        {action.similes?.length
                          ? ` • ${formatAliasCount(action.similes.length)}`
                          : ""}
                      </p>
                    </div>

                    <span
                      className={`text-2xs px-1.5 py-0.5 rounded whitespace-nowrap ${
                        HANDLER_TYPE_COLORS[action.handler.type] ||
                        "bg-surface text-muted"
                      }`}
                    >
                      {handlerTypeLabel(action.handler.type, t)}
                    </span>
                  </div>

                  {action.description && (
                    <p className="text-xs text-muted line-clamp-2 break-words">
                      {action.description}
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: form control is associated programmatically */}
                    <label className="flex items-center gap-1 cursor-pointer text-xs text-muted">
                      <Switch
                        checked={action.enabled}
                        onCheckedChange={() => handleToggleEnabled(action)}
                        className="scale-75"
                      />
                      <span>{t("common.enabled")}</span>
                    </label>

                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(action)}
                        className="h-6 px-2 text-xs text-txt hover:text-txt/80 hover:bg-accent/10"
                        title={t("customactionspanel.EditAction")}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(action)}
                        className="h-6 px-2 text-xs text-danger hover:text-danger/80 hover:bg-danger/10"
                        title={t("customactionspanel.DeleteAction")}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
