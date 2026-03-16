import type { Metadata } from "next";
import { ImagePageClient } from "@/components/image/image-page-client";
import { generatePageMetadata, ROUTE_METADATA } from "@/lib/seo";
import { listUserMedia, type GalleryItem } from "@/app/actions/gallery";

export const dynamic = "force-dynamic";

export const metadata: Metadata = generatePageMetadata({
  ...ROUTE_METADATA.imageGeneration,
  path: "/dashboard/image",
  noIndex: true,
});

/**
 * Image Generation page for creating AI-generated images.
 * Fetches initial history from the server for immediate display.
 *
 * @returns The rendered image generation page client component.
 */
export default async function ImagePage() {
  let initialHistory: GalleryItem[] = [];

  try {
    initialHistory = await listUserMedia({ type: "image", limit: 12 });
  } catch {
    // Silent fail for anonymous users
  }

  return <ImagePageClient initialHistory={initialHistory} />;
}
