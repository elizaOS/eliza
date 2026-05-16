import { useQuery } from "@tanstack/react-query";
import type { GalleryItem } from "@/lib/types/gallery";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

type GalleryItemKind = "image" | "video";

interface GalleryListResponseRaw {
  items: Array<{
    id: string;
    type: GalleryItemKind;
    url: string;
    thumbnailUrl?: string | null;
    prompt: string;
    model: string;
    status: string;
    createdAt: string;
    completedAt?: string | null;
    dimensions?: { width?: number; height?: number; duration?: number } | null;
    mimeType?: string | null;
    fileSize?: string | null;
  }>;
}

interface GalleryListOptions {
  type?: GalleryItemKind;
  limit?: number;
  offset?: number;
}

function buildGalleryQuery(options?: GalleryListOptions): string {
  const params = new URLSearchParams();
  if (options?.type) params.set("type", options.type);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined)
    params.set("offset", String(options.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function mapGalleryItem(
  raw: GalleryListResponseRaw["items"][number],
): GalleryItem {
  return {
    id: raw.id,
    type: raw.type,
    url: raw.url,
    thumbnailUrl: raw.thumbnailUrl ?? undefined,
    prompt: raw.prompt,
    model: raw.model,
    status: raw.status,
    createdAt: new Date(raw.createdAt),
    completedAt: raw.completedAt ? new Date(raw.completedAt) : undefined,
    dimensions: raw.dimensions ?? undefined,
    mimeType: raw.mimeType ?? undefined,
    fileSize: raw.fileSize ? BigInt(raw.fileSize) : undefined,
  };
}

/** GET /api/v1/gallery — caller's gallery items, optionally filtered by type. */
export function useGallery(options?: GalleryListOptions) {
  const gate = useAuthenticatedQueryGate();
  const queryString = buildGalleryQuery(options);
  return useQuery({
    queryKey: authenticatedQueryKey(
      [
        "gallery",
        options?.type ?? "all",
        options?.limit ?? null,
        options?.offset ?? null,
      ],
      gate,
    ),
    queryFn: async () => {
      const data = await api<GalleryListResponseRaw>(
        `/api/v1/gallery${queryString}`,
      );
      return data.items.map(mapGalleryItem);
    },
    enabled: gate.enabled,
  });
}
