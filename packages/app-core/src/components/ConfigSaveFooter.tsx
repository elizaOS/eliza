import { SaveFooter } from "@elizaos/ui";
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
  return (
    <SaveFooter
      dirty={dirty}
      saving={saving}
      saveError={saveError}
      saveSuccess={saveSuccess}
      onSave={onSave}
      saveLabel="Save Changes"
      savingLabel="Saving..."
      savedLabel={t("configsavefooter.Saved")}
      className="border-[var(--border)]"
    />
  );
}
