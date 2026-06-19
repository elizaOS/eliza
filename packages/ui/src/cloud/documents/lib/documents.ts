/**
 * Documents-domain data layer: per-character knowledge CRUD + query against
 * `/api/v1/documents`.
 *
 * Replaces the raw `fetch()` + manual loading/error state the cloud-frontend
 * page client carried with the shared typed `api`/`apiFetch` client and
 * react-query. The list query is keyed by `characterId` so switching the scope
 * selector refetches; mutations invalidate the list so the UI never has to
 * `window.location.reload()`.
 *
 * Service-unavailable (503) is a first-class, non-throwing result so the page
 * can render the "Knowledge service is not available" surface instead of an
 * error boundary.
 */

import type {
  CloudDocument,
  QueryResult,
} from "@elizaos/cloud-shared/lib/types/documents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, apiFetch } from "../../lib/api-client";

export type { CloudDocument, QueryResult };

interface DocumentsListResponse {
  documents?: CloudDocument[];
}

interface DocumentQueryResponse {
  results?: QueryResult[];
}

interface DocumentMutationResponse {
  message?: string;
}

const DOCUMENTS_BASE = "/api/v1/documents";

function documentsListKey(characterId: string | null): readonly unknown[] {
  return ["cloud", "documents", characterId];
}

/** Discriminated result so 503 (service down) is not an error path. */
export type DocumentsListState =
  | { status: "ok"; documents: CloudDocument[] }
  | { status: "service-unavailable"; message: string };

async function fetchDocuments(
  characterId: string | null,
): Promise<DocumentsListState> {
  const query = characterId
    ? `?characterId=${encodeURIComponent(characterId)}`
    : "";
  try {
    const data = await api<DocumentsListResponse>(`${DOCUMENTS_BASE}${query}`);
    return { status: "ok", documents: data.documents ?? [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) {
      return { status: "service-unavailable", message: error.message };
    }
    throw error;
  }
}

/**
 * List documents for the selected character. Disabled until a character is
 * selected (the scope selector). 503 resolves to a `service-unavailable`
 * state rather than throwing.
 */
export function useDocuments(characterId: string | null) {
  return useQuery({
    queryKey: documentsListKey(characterId),
    queryFn: () => fetchDocuments(characterId),
    enabled: characterId !== null,
  });
}

export function useDeleteDocument(characterId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const query = characterId
        ? `?characterId=${encodeURIComponent(characterId)}`
        : "";
      await apiFetch(
        `${DOCUMENTS_BASE}/${encodeURIComponent(documentId)}${query}`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: documentsListKey(characterId),
      });
    },
  });
}

export interface UploadFilesInput {
  files: File[];
  /** Pre-resolved MIME types, aligned with `files` by index. */
  mimeTypes: string[];
  characterId: string | null;
}

export function useUploadFiles(characterId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      files,
      mimeTypes,
      characterId: cid,
    }: UploadFilesInput) => {
      const formData = new FormData();
      if (cid) formData.append("characterId", cid);
      files.forEach((file, index) => {
        const blob = new Blob([file], {
          type: mimeTypes[index] ?? file.type ?? "application/octet-stream",
        });
        formData.append("files", blob, file.name);
      });
      return api<DocumentMutationResponse>(`${DOCUMENTS_BASE}/upload-file`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: documentsListKey(characterId),
      });
    },
  });
}

export interface UploadTextInput {
  content: string;
  filename: string;
  characterId: string | null;
}

export function useUploadText(characterId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      content,
      filename,
      characterId: cid,
    }: UploadTextInput) =>
      api<DocumentMutationResponse>(DOCUMENTS_BASE, {
        method: "POST",
        json: {
          content,
          contentType: "text/plain",
          filename,
          characterId: cid || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: documentsListKey(characterId),
      });
    },
  });
}

export interface QueryDocumentsInput {
  query: string;
  limit: number;
  characterId: string | null;
}

export function useQueryDocuments() {
  return useMutation({
    mutationFn: async ({ query, limit, characterId }: QueryDocumentsInput) => {
      const data = await api<DocumentQueryResponse>(`${DOCUMENTS_BASE}/query`, {
        method: "POST",
        json: { query, limit, characterId: characterId || undefined },
      });
      return data.results ?? [];
    },
  });
}
