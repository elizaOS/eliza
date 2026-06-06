import type { DocumentRecord } from "../../api/client-types-chat";
import { formatByteSize } from "../../utils/format";

export function getDocumentTypeLabel(contentType?: string): string {
  return contentType?.split("/").pop()?.toUpperCase() || "DOCUMENT";
}

export function getDocumentSourceLabel(
  source: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (source === "youtube") {
    return t("documentsview.YouTube", { defaultValue: "YouTube" });
  }
  if (source === "url") {
    return t("documentsview.FromUrl", { defaultValue: "From URL" });
  }
  return t("aria.upload", { defaultValue: "Upload" });
}

export function getDocumentSummary(
  doc: DocumentRecord,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const fragmentLabel =
    doc.fragmentCount === 1
      ? t("documentsview.FragmentCountOne", {
          defaultValue: "1 fragment",
        })
      : t("documentsview.FragmentCountMany", {
          defaultValue: "{{count}} fragments",
          count: doc.fragmentCount,
        });
  return `${getDocumentSourceLabel(doc.source, t)} • ${fragmentLabel} • ${formatByteSize(doc.fileSize)}`;
}
