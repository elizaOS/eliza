import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";

export default function SettingsLoading() {
  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 sm:px-0">
        {/* Header */}
        <div className="space-y-2">
          <Skeleton className="h-8 w-32 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>

        {/* Settings Sections */}
        {Array.from({ length: 4 }).map((_, sectionIdx) => (
          <div
            key={sectionIdx}
            className="space-y-4 rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6"
          >
            <Skeleton className="mb-4 h-6 w-40 max-w-full" />
            {Array.from({ length: 3 }).map((_, itemIdx) => (
              <div
                key={itemIdx}
                className="flex items-center justify-between gap-3 border-border/5 border-b py-3 last:border-0"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 max-w-full" />
                  <Skeleton className="h-3 w-48 max-w-full" />
                </div>
                <Skeleton className="h-8 w-16 shrink-0 rounded-full" />
              </div>
            ))}
          </div>
        ))}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-32 rounded-lg" />
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
      </div>
    </PageContainer>
  );
}
