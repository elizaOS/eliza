import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

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
        className={cn("flex items-center justify-end gap-3 pt-2", className)}
        {...props}
      >
        {saveError && (
          <span className="text-xs text-destructive">{saveError}</span>
        )}
        {saveSuccess && <span className="text-xs text-ok">{savedLabel}</span>}
        <Button
          size="sm"
          className="text-txt-strong hover:text-txt-strong"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? savingLabel : saveLabel}
        </Button>
      </div>
    );
  },
);
SaveFooter.displayName = "SaveFooter";
