import type { CustomActionDef } from "@elizaos/agent";
import { Button, Input, Switch } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api/client";
import { useApp } from "../../state/useApp";
import {
  alertDesktopMessage,
  confirmDesktopAction,
} from "../../utils/desktop-dialogs";
import { CustomActionEditor } from "./CustomActionEditor";

const CUSTOM_ACTIONS_SHELL_CLASS =
  "flex h-full min-h-0 flex-col gap-4 rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm ring-1 ring-border/15 backdrop-blur-sm";
const CUSTOM_ACTIONS_PANEL_CLASS =
  "rounded-2xl border border-border/45 bg-bg/20 shadow-sm";
const CUSTOM_ACTIONS_TOOLBAR_BUTTON_CLASS =
  "h-10 rounded-xl px-3 text-sm shadow-sm";
const CUSTOM_ACTIONS_INPUT_CLASS =
  "h-10 rounded-xl border-border/60 bg-bg/55 px-3 text-sm shadow-sm";

const HANDLER_BADGE_CLASS: Record<string, string> = {
  http: "border border-info/25 bg-info/10 text-info",
  shell: "border border-success/25 bg-success/10 text-success",
  code: "border border-accent/25 bg-accent/10 text-accent",
};

export function CustomActionsView() {
  const { t } = useApp();
  const [actions, setActions] = useState<CustomActionDef[]>([]);
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<CustomActionDef | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const loadActions = useCallback(async () => {
    try {
      setLoading(true);
      const result = await client.listCustomActions();
      setActions(result);
    } catch (error) {
      console.error("Failed to load custom actions:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadActions();
  }, [loadActions]);

  const handleCreate = useCallback(() => {
    setEditingAction(null);
    setEditorOpen(true);
  }, []);

  const handleEdit = useCallback((action: CustomActionDef) => {
    setEditingAction(action);
    setEditorOpen(true);
  }, []);

  const handleEditorClose = useCallback(() => {
    setEditorOpen(false);
    setEditingAction(null);
  }, []);

  const handleEditorSave = useCallback(async () => {
    setEditorOpen(false);
    setEditingAction(null);
    await loadActions();
  }, [loadActions]);

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await client.updateCustomAction(id, { enabled });
        setActions((prev) =>
          prev.map((action) =>
            action.id === id ? { ...action, enabled } : action,
          ),
        );
      } catch (error) {
        console.error("Failed to toggle action:", error);
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      const confirmed = await confirmDesktopAction({
        title: t("customactionsview.DeleteCustomActionTitle"),
        message: t("customactionsview.DeleteCustomActionMessage", { name }),
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        type: "warning",
      });
      if (!confirmed) {
        return;
      }

      try {
        await client.deleteCustomAction(id);
        setActions((prev) => prev.filter((action) => action.id !== id));
      } catch (error) {
        console.error("Failed to delete action:", error);
      }
    },
    [t],
  );

  const handleImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        const actionsToImport = Array.isArray(imported) ? imported : [imported];

        for (const action of actionsToImport) {
          await client.createCustomAction(action);
        }

        await loadActions();
        event.target.value = "";
      } catch (error) {
        console.error("Failed to import actions:", error);
        await alertDesktopMessage({
          title: t("customactionsview.ImportFailedTitle"),
          message: t("customactionsview.ImportFailedMessage"),
          type: "error",
        });
      }
    },
    [loadActions, t],
  );

  const handleExport = useCallback(() => {
    const dataStr = JSON.stringify(actions, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "custom-actions.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [actions]);

  const filteredActions = actions.filter((action) => {
    const searchLower = search.toLowerCase();
    return (
      action.name.toLowerCase().includes(searchLower) ||
      action.description?.toLowerCase().includes(searchLower)
    );
  });

  const actionCountLabel = t(
    actions.length === 1
      ? "customactionsview.ActionCountOne"
      : "customactionsview.ActionCountOther",
    { count: actions.length },
  );

  if (loading) {
    return (
      <div className={CUSTOM_ACTIONS_SHELL_CLASS}>
        <div
          className={`${CUSTOM_ACTIONS_PANEL_CLASS} flex flex-1 items-center justify-center px-6 py-16 text-sm text-muted`}
        >
          {t("customactionsview.LoadingActions")}
        </div>
      </div>
    );
  }

  const emptyState = (
    <div
      className={`${CUSTOM_ACTIONS_PANEL_CLASS} flex flex-1 flex-col items-center justify-center px-6 py-14 text-center`}
    >
      <div className="max-w-md space-y-3">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
          {t("customactionsview.CustomActions")}
        </div>
        <h2 className="text-xl font-semibold text-txt">
          {search
            ? t("customactionsview.NoActionsMatchFiltersTitle")
            : t("customactionsview.EmptyTitle")}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {search
            ? t("customactionsview.NoActionsMatchFiltersDescription")
            : t("customactionsview.EmptyDescription")}
        </p>
        {!search && (
          <div className="pt-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              className="h-10 rounded-xl px-4 text-sm font-medium shadow-sm"
            >
              {t("customactionsview.CreateAction")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-testid="custom-actions-view"
      className={CUSTOM_ACTIONS_SHELL_CLASS}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            {t("customactionsview.CustomActions")}
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-txt">
              {t("customactionsview.ActionRegistry")}
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted">
              {t("customactionsview.ActionRegistryDescription")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="rounded-full border border-border/45 bg-bg/30 px-3 py-1.5 shadow-sm">
            {actionCountLabel}
          </span>
          <span className="rounded-full border border-border/45 bg-bg/30 px-3 py-1.5 shadow-sm">
            {search
              ? t("customactionsview.Filtered")
              : t("customactionsview.AllActions")}
          </span>
        </div>
      </div>

      <div className={`${CUSTOM_ACTIONS_PANEL_CLASS} p-3 sm:p-4`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex-1 space-y-2">
            <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
              {t("customactionsview.SearchAndManage")}
            </div>
            <Input
              type="text"
              placeholder={t("customactionsview.SearchActionsByNa")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`w-full ${CUSTOM_ACTIONS_INPUT_CLASS}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`${CUSTOM_ACTIONS_TOOLBAR_BUTTON_CLASS} inline-flex cursor-pointer items-center rounded-xl border border-border/60 bg-bg/35 text-muted transition-colors hover:border-border hover:bg-bg/55 hover:text-txt`}
            >
              {t("settings.import")}
              <input
                type="file"
                accept="application/json"
                onChange={handleImport}
                className="hidden"
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={actions.length === 0}
              className={`${CUSTOM_ACTIONS_TOOLBAR_BUTTON_CLASS} bg-bg/35 text-muted hover:bg-bg/55 disabled:opacity-50`}
            >
              {t("common.export")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              className={`${CUSTOM_ACTIONS_TOOLBAR_BUTTON_CLASS} font-medium`}
            >
              {t("customactionsview.CreateAction")}
            </Button>
          </div>
        </div>
      </div>

      {filteredActions.length === 0 ? (
        emptyState
      ) : (
        <div className="grid flex-1 auto-rows-fr grid-cols-1 gap-3 overflow-auto md:grid-cols-2 xl:grid-cols-3">
          {filteredActions.map((action) => (
            <div
              key={action.id}
              className={`${CUSTOM_ACTIONS_PANEL_CLASS} flex h-full flex-col gap-4 p-4 transition-[border-color,background-color,box-shadow] hover:border-accent/35 hover:bg-bg/30`}
            >
              <Button
                variant="ghost"
                className="m-0 h-auto w-full p-0 text-left"
                onClick={() => handleEdit(action)}
              >
                <div className="flex w-full flex-1 flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted/70">
                        {t("customactionsview.Handler")}
                      </div>
                      <h3 className="flex-1 break-words text-base font-semibold text-txt">
                        {action.name}
                      </h3>
                    </div>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-xs-tight font-medium ${
                        HANDLER_BADGE_CLASS[action.handler.type] ??
                        "border-border/55 bg-bg/35 text-muted"
                      }`}
                    >
                      {action.handler.type}
                    </span>
                  </div>

                  {action.description ? (
                    <p className="line-clamp-3 text-sm leading-relaxed text-muted">
                      {action.description}
                    </p>
                  ) : (
                    <p className="text-sm leading-relaxed text-muted/75">
                      {t("customactionsview.NoDescriptionYet")}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="rounded-full border border-border/45 bg-bg/30 px-2.5 py-1">
                      {t(
                        (action.parameters?.length || 0) === 1
                          ? "customactionsview.ParameterCountOne"
                          : "customactionsview.ParameterCountOther",
                        { count: action.parameters?.length || 0 },
                      )}
                    </span>
                    <span className="rounded-full border border-border/45 bg-bg/30 px-2.5 py-1">
                      {action.enabled
                        ? t("common.enabled")
                        : t("common.disabled")}
                    </span>
                  </div>
                </div>
              </Button>

              <div className="mt-auto flex items-center justify-between gap-3 pt-3">
                {/* biome-ignore lint/a11y/noLabelWithoutControl: form control is associated programmatically */}
                <label className="flex min-h-touch cursor-pointer items-center gap-2">
                  <Switch
                    checked={action.enabled}
                    onCheckedChange={(checked: boolean | "indeterminate") =>
                      handleToggleEnabled(action.id, !!checked)
                    }
                  />
                  <span className="text-xs text-muted">
                    {t("common.enabled")}
                  </span>
                </label>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(action)}
                    className="h-9 rounded-xl px-3 text-xs bg-bg/35 text-muted hover:bg-bg/55"
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(action.id, action.name)}
                    className="h-9 rounded-xl border-danger/35 bg-danger/5 px-3 text-xs text-danger hover:border-danger hover:bg-danger/10"
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor Modal */}
      {editorOpen && (
        <CustomActionEditor
          open={editorOpen}
          action={editingAction}
          onClose={handleEditorClose}
          onSave={handleEditorSave}
        />
      )}
    </div>
  );
}
