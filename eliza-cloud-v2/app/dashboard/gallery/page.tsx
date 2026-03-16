import type { Metadata } from "next";
import { GalleryPageClient } from "@/components/gallery/gallery-page-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery",
  description:
    "View and manage all your AI-generated content including images and videos",
};

/**
 * Gallery page for viewing and managing all AI-generated content (images and videos).
 *
 * @returns The rendered gallery page client component.
 */
export default function GalleryPage() {
  return <GalleryPageClient />;
}
