/**
 * Image page client component wrapping the advanced image generator.
 * Sets page header context for the image studio page.
 */

"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import type { GalleryItem } from "@/lib/types/gallery";
import { ImageGeneratorAdvanced } from "./image-generator-advanced";

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
