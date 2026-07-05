/**
 * Shared bulk-selection UI for console tables: the selection bar shown while
 * rows are checked, the destructive confirm dialog, and the allSettled
 * partition helper for multi-delete flows. Extracted from the byte-duplicated
 * implementations in the Apps and Agents tables (#13916); copy is caller-
 * supplied (each domain keeps its own i18n keys) and styling uses semantic
 * theme tokens so both tables render correctly on light theme (#13755 class).
 * Toasts and cache semantics stay at call sites — they differ meaningfully
 * per domain (query-cache surgery vs tombstones) and are not chrome.
 */

import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";

export interface BulkSelectionBarLabels {
  selected: string;
  clear: string;
  deleteSelected: string;
}

/** The bar shown above a table while rows are selected; renders nothing at
 * count 0 so callers can mount it unconditionally. */
export function BulkSelectionBar({
  count,
  onClear,
  onDelete,
  deleteDisabled = false,
  labels,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
  deleteDisabled?: boolean;
  labels: BulkSelectionBarLabels;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-sm border border-border bg-surface px-3 py-2">
      <span className="text-sm text-txt">{labels.selected}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          type="button"
          onClick={onClear}
          className="h-8 px-3 text-muted hover:text-txt"
        >
          {labels.clear}
        </Button>
        <Button
          variant="ghost"
          type="button"
          disabled={deleteDisabled}
          onClick={onDelete}
          className="h-8 px-3 text-destructive hover:bg-destructive-subtle"
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          {labels.deleteSelected}
        </Button>
      </div>
    </div>
  );
}

/** Destructive confirm dialog for bulk deletes. Title/description arrive
 * precomputed (singular/plural phrasing is domain copy, not chrome). */
export function BulkDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  confirmDisabled = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  cancelLabel: string;
  confirmLabel: React.ReactNode;
  confirmDisabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="bg-card border-border">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-txt-strong">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-muted">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-border bg-transparent text-txt hover:bg-surface">
            {cancelLabel}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface BulkDeleteOutcome<T> {
  /** Inputs whose delete fulfilled, in input order. */
  deleted: T[];
  /** Inputs whose delete rejected, in input order. */
  failed: T[];
  /** The first rejection reason, for the caller's error toast. */
  firstError: unknown;
}

/** Run one delete per item via Promise.allSettled and partition the outcome —
 * the shared skeleton of every console bulk-delete flow. Never throws; the
 * caller decides how failures surface (per-domain toasts + cache semantics). */
export async function runBulkDelete<T>(
  items: readonly T[],
  deleteOne: (item: T) => Promise<unknown>,
): Promise<BulkDeleteOutcome<T>> {
  const results = await Promise.allSettled(
    items.map((it) => Promise.resolve().then(() => deleteOne(it))),
  );
  const deleted = items.filter((_, i) => results[i].status === "fulfilled");
  const failed = items.filter((_, i) => results[i].status === "rejected");
  const firstError = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  )?.reason;
  return { deleted, failed, firstError };
}
