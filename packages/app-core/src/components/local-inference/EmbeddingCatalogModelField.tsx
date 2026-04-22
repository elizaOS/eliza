import type { ReactNode } from "react";
import type {
  CatalogModel,
  InstalledModel,
} from "../../api/client-local-inference";
import { formatEmbeddingChoiceLabel } from "./hub-utils";

type Props = {
  catalog: CatalogModel[];
  installedChoices: InstalledModel[];
  /** Current assignment id, or "" when unset. */
  value: string;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
  unsetLabel: string;
  emptyMessage: ReactNode;
};

/**
 * Curated embedding installs: one row shows a read-only **Model** label; several
 * rows use a &lt;select&gt; with {@link formatEmbeddingChoiceLabel} (name · dimensions).
 */
export function EmbeddingCatalogModelField({
  catalog,
  installedChoices,
  value,
  onChange,
  disabled,
  unsetLabel,
  emptyMessage,
}: Props) {
  if (installedChoices.length === 0) {
    return <>{emptyMessage}</>;
  }

  if (installedChoices.length === 1) {
    const only = installedChoices[0];
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Model</div>
        <output
          className="block rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm text-foreground"
          aria-live="polite"
        >
          {formatEmbeddingChoiceLabel(only, catalog)}
        </output>
      </div>
    );
  }

  const validIds = new Set(installedChoices.map((m) => m.id));
  const selectValue = validIds.has(value) ? value : "";

  return (
    <select
      value={selectValue}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className="rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm"
    >
      <option value="">{unsetLabel}</option>
      {installedChoices.map((m) => (
        <option key={m.id} value={m.id}>
          {formatEmbeddingChoiceLabel(m, catalog)}
        </option>
      ))}
    </select>
  );
}
