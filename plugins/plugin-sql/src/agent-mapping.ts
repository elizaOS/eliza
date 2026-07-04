/**
 * Bidirectional mappers between the runtime's `Agent`-facing message-example
 * and document/knowledge shapes and the legacy nested-array / string forms
 * stored in the agents table's JSONB columns, so older rows keep loading
 * under the current `MessageExampleGroup[]` / `DocumentSourceItem[]` types.
 */
import type { DocumentSourceItem, MessageExample, MessageExampleGroup } from "@elizaos/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessageExampleGroup(entry: unknown): entry is MessageExampleGroup {
  return isRecord(entry) && "examples" in entry && Array.isArray(entry.examples);
}

/** DB rows may use legacy nested arrays; normalize to Agent's MessageExampleGroup[]. */
export function messageExamplesFromDb(
  raw: readonly MessageExampleGroup[] | readonly unknown[][] | null | undefined
): MessageExampleGroup[] {
  if (!raw || raw.length === 0) return [];
  if (isMessageExampleGroup(raw[0])) {
    return [...raw] as MessageExampleGroup[];
  }
  const first = raw[0];
  if (first !== undefined && Array.isArray(first)) {
    return (raw as MessageExample[][]).map((examples) => ({ examples }));
  }
  return [];
}

/** Maps Agent's MessageExampleGroup[] back to the DB's legacy nested-array column shape. */
export function messageExamplesToDb(
  groups: readonly MessageExampleGroup[] | null | undefined
): MessageExample[][] {
  if (!groups || groups.length === 0) return [];
  return groups.map((group) => group.examples);
}

/** Maps legacy Agent document/knowledge entries to protobuf-shaped DocumentSourceItem. */
export function documentsFromDb(raw: readonly unknown[] | null | undefined): DocumentSourceItem[] {
  if (!raw || raw.length === 0) return [];
  const out: DocumentSourceItem[] = [];
  for (const entry of raw) {
    const n = normalizeLegacyDocumentEntry(entry);
    if (n) out.push(n);
  }
  return out;
}

/** Maps Agent's protobuf-shaped DocumentSourceItem entries to the DB knowledge column shape. */
export function documentsToDb(
  documents: readonly DocumentSourceItem[] | null | undefined
): (string | { path: string; shared?: boolean })[] {
  if (!documents || documents.length === 0) return [];
  const out: (string | { path: string; shared?: boolean })[] = [];
  for (const document of documents) {
    if (document.item.case === "path") {
      out.push(document.item.value);
    } else if (document.item.case === "directory") {
      const { path, directory, shared } = document.item.value;
      const resolvedPath = path ?? directory;
      if (typeof resolvedPath === "string") {
        out.push({ path: resolvedPath, shared });
      }
    }
  }
  return out;
}

function normalizeLegacyDocumentEntry(raw: unknown): DocumentSourceItem | null {
  if (typeof raw === "string") {
    return { item: { case: "path", value: raw } };
  }
  if (!isRecord(raw)) {
    return null;
  }
  if ("item" in raw && isRecord(raw.item)) {
    const caseValue = raw.item.case;
    if (caseValue === "path" && typeof raw.item.value === "string") {
      return raw as DocumentSourceItem;
    }
    if (
      caseValue === "directory" &&
      isRecord(raw.item.value) &&
      typeof raw.item.value.path === "string"
    ) {
      return raw as DocumentSourceItem;
    }
  }
  if ("path" in raw && typeof raw.path === "string") {
    return { item: { case: "path", value: raw.path } };
  }
  if ("directory" in raw && typeof raw.directory === "string") {
    return {
      item: {
        case: "directory",
        value: {
          directory: raw.directory,
          shared: typeof raw.shared === "boolean" ? raw.shared : undefined,
        },
      },
    };
  }
  return null;
}
