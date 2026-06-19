import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";

export default function NftGalleryLoading() {
  return (
    <PageContainer noPadding className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border border-b bg-card px-4 py-5">
        <div className="mx-auto max-w-5xl">
          <Skeleton className="mb-2 h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="border-border border-b px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-6 w-32" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <Skeleton className="aspect-square w-full" />
                <div className="p-2.5">
                  <Skeleton className="mb-2 h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
