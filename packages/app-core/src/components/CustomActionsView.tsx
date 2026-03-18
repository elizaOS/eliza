import { type CustomActionDef, client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import {
  alertDesktopMessage,
  confirmDesktopAction,
} from "@elizaos/app-core/utils";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { CustomActionEditor } from "./CustomActionEditor";

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

  const handleDelete = useCallback(async (id: string, name: string) => {
    const confirmed = await confirmDesktopAction({
      title: "Delete Custom Action",
      message: `Are you sure you want to delete "${name}"?`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
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
  }, []);

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
          title: "Import Failed",
          message: "Failed to import actions. Please check the file format.",
          type: "error",
        });
      }
    },
    [loadActions],
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

  const getBadgeColor = (handlerType: string) => {
    switch (handlerType) {
      case "http":
        return "bg-blue-500/20 text-blue-400";
      case "shell":
        return "bg-green-500/20 text-green-400";
      case "code":
        return "bg-purple-500/20 text-purple-400";
      default:
        return "bg-gray-500/20 text-gray-400";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted">
          {t("customactionsview.LoadingActions")}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="custom-actions-view"
      className="flex flex-col h-full p-4 space-y-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <label className="px-3 py-1.5 text-sm border border-border bg-surface text-muted rounded cursor-pointer hover:bg-card transition-colors">
            {t("knowledgeview.Import")}
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
            className="px-3 py-1.5 h-8 text-sm text-muted bg-surface hover:bg-card shadow-sm disabled:opacity-50"
          >
            {t("customactionsview.Export")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleCreate}
            className="px-3 py-1.5 h-8 text-sm shadow-sm font-medium tracking-wide"
          >
            {t("customactionsview.CreateAction")}
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex items-center">
        <Input
          type="text"
          placeholder={t("customactionsview.SearchActionsByNa")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 h-9 text-sm bg-surface text-txt shadow-sm"
        />
      </div>

      {/* Actions Grid */}
      {filteredActions.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 space-y-4">
          <p className="text-muted text-center">
            {search
              ? "No actions match your search."
              : "No custom actions yet. Create one to get started."}
          </p>
          {!search && (
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              className="px-4 py-2 text-sm shadow-sm font-medium tracking-wide"
            >
              {t("customactionsview.CreateAction")}
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 overflow-auto">
          {filteredActions.map((action) => (
            <div
              key={action.id}
              className="border border-border bg-card rounded p-4 space-y-3 cursor-pointer hover:border-accent/50 transition-colors"
            >
              <button
                type="button"
                className="w-full bg-transparent border-0 p-0 m-0 text-left cursor-pointer"
                onClick={() => handleEdit(action)}
              >
                {/* Name and Badge */}
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-sm text-txt flex-1 break-words">
                    {action.name}
                  </h3>
                  <span
                    className={`px-2 py-0.5 text-xs rounded ${getBadgeColor(
                      action.handler.type,
                    )}`}
                  >
                    {action.handler.type}
                  </span>
                </div>

                {/* Description */}
                {action.description && (
                  <p className="text-xs text-muted line-clamp-3">
                    {action.description}
                  </p>
                )}

                {/* Parameters Count */}
                <p className="text-xs text-muted">
                  {action.parameters?.length || 0}{" "}
                  {t("customactionsview.parameter")}
                  {action.parameters?.length === 1 ? "" : "s"}
                </p>
              </button>

              {/* Actions Row */}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={action.enabled}
                    onChange={(e) =>
                      handleToggleEnabled(action.id, e.target.checked)
                    }
                    className="cursor-pointer"
                  />
                  <span className="text-xs text-muted">
                    {t("customactionsview.Enabled")}
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(action)}
                    className="px-2 py-1 h-6 text-xs bg-surface text-muted hover:bg-card shadow-sm"
                  >
                    {t("triggersview.Edit")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(action.id, action.name)}
                    className="px-2 py-1 h-6 text-xs bg-surface text-danger border-danger/20 hover:bg-danger/10 shadow-sm"
                  >
                    {t("triggersview.Delete")}
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
