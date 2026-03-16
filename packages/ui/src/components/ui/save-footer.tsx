import * as React from "react";
import { cn } from "../../lib/utils";

export interface SaveFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  saveSuccess: boolean;
  onSave: () => void;
  saveLabel?: string;
  savingLabel?: string;
  savedLabel?: string;
}

export const SaveFooter = React.forwardRef<HTMLDivElement, SaveFooterProps>(
  (
    {
      dirty,
      saving,
      saveError,
      saveSuccess,
      onSave,
      saveLabel = "Save Changes",
      savingLabel = "Saving…",
      savedLabel = "Saved",
      className,
      ...props
    },
    ref,
  ) => {
    if (!dirty) return null;

    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center justify-end gap-3 border-t border-border pt-2",
          className,
        )}
        {...props}
      >
        {saveError && (
          <span className="text-xs text-destructive">{saveError}</span>
        )}
        {saveSuccess && <span className="text-xs text-ok">{savedLabel}</span>}
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? savingLabel : saveLabel}
        </button>
      </div>
    );
  },
);
SaveFooter.displayName = "SaveFooter";
