import { Button } from "@elizaos/ui";
import { useApp } from "../state";

export function ConfigSaveFooter({
  dirty,
  saving,
  saveError,
  saveSuccess,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: boolean;
  onSave: () => void;
}) {
  const { t } = useApp();
  if (!dirty) {
    return null;
  }

  return (
    <div className="flex items-center justify-end gap-3 pt-2 border-t border-[var(--border)]">
      {saveError && <span className="text-xs text-red-500">{saveError}</span>}
      {saveSuccess && (
        <span className="text-xs text-green-600">
          {t("configsavefooter.Saved")}
        </span>
      )}
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        disabled={saving}
        onClick={onSave}
      >
        {saving ? "Saving..." : "Save Changes"}
      </Button>
    </div>
  );
}
