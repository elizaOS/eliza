/**
 * Image page client component wrapping the advanced image generator.
 * Sets page header context for the image studio page.
 */

"use client";

import { ImageGeneratorAdvanced } from "./image-generator-advanced";
import { useSetPageHeader } from "@/components/layout/page-header-context";
import type { GalleryItem } from "@/app/actions/gallery";

interface ImagePageClientProps {
  initialHistory?: GalleryItem[];
}

export function ImagePageClient({ initialHistory = [] }: ImagePageClientProps) {
  useSetPageHeader({
    title: "Image Studio",
  });

  return (
    <div className="flex flex-col w-full h-full min-h-0">
      <div className="flex-1 w-full max-w-[1800px] mx-auto px-4 md:px-6 flex flex-col min-h-0">
        <ImageGeneratorAdvanced initialHistory={initialHistory} />
      </div>
    </div>
  );
}
