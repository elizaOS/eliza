import { Separator } from "@/components/shared/Separator";

function SkeletonBox({
  className = "",
  delay = 0,
}: {
  className?: string;
  delay?: number;
}) {
  return (
    <div
      className={`animate-pulse rounded bg-muted/50 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden="true"
    />
  );
}

function SkeletonText({
  className = "",
  delay = 0,
}: {
  className?: string;
  delay?: number;
}) {
  return (
    <div
      className={`h-4 animate-pulse rounded bg-muted/50 ${className}`}
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden="true"
    />
  );
}

export function RewardsSkeleton() {
  return (
    <div role="status" aria-label="Loading rewards...">
      {/* Desktop Layout */}
      <div className="hidden flex-1 overflow-hidden xl:flex">
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden border-border p-4 sm:p-6 lg:border-l">
          {/* Header */}
          <div className="mb-4">
            <SkeletonText className="mb-2 h-8 w-32" />
            <SkeletonText className="h-4 w-96" />
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex items-center gap-2">
                  <SkeletonBox className="h-5 w-5" delay={i * 50} />
                  <SkeletonText className="h-4 w-24" delay={i * 50} />
                </div>
                <SkeletonText className="h-8 w-20" delay={i * 50} />
              </div>
            ))}
          </div>

          {/* Daily Rewards placeholder */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-5 w-32" />
            </div>
            <SkeletonBox className="h-16 w-full rounded-lg" />
          </div>

          {/* Earn Points (tasks + share) */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-4 flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-5 w-28" />
            </div>

            <div className="grid gap-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 rounded-lg border border-border p-4"
                >
                  <SkeletonBox className="h-6 w-6 shrink-0" delay={i * 50} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <SkeletonText className="h-4 w-32" delay={i * 50} />
                    <SkeletonText className="h-3 w-48" delay={i * 50} />
                  </div>
                  <div className="shrink-0 space-y-1 text-right">
                    <SkeletonText className="h-4 w-12" delay={i * 50} />
                    <SkeletonText className="h-3 w-12" delay={i * 50} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Referral Link */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-5 w-28" />
              <SkeletonText className="h-3 w-48" />
            </div>

            <div className="space-y-3">
              <div className="flex gap-2">
                <SkeletonBox className="h-10 flex-1 rounded-lg" />
                <SkeletonBox className="h-10 w-[84px] rounded-lg" />
              </div>
              <div className="flex gap-2">
                <SkeletonBox className="h-10 flex-1 rounded-lg" />
                <SkeletonBox className="h-10 flex-1 rounded-lg" />
              </div>
            </div>
          </div>

          {/* Referred Users List */}
          <div>
            <div className="mb-3 flex items-center gap-1.5">
              <SkeletonBox className="h-4 w-4" />
              <SkeletonText className="h-5 w-32" />
            </div>

            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <SkeletonBox
                    className="h-8 w-8 shrink-0 rounded-full"
                    delay={i * 50}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <SkeletonText className="h-4 w-28" delay={i * 50} />
                    <SkeletonText className="h-3 w-20" delay={i * 50} />
                  </div>
                  <SkeletonBox className="h-4 w-4" delay={i * 50} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile/Tablet Layout */}
      <div className="flex w-full flex-1 flex-col overflow-y-auto border-border lg:border-l xl:hidden">
        <div className="w-full space-y-4 px-4 py-4 sm:space-y-6 sm:px-6 sm:py-6">
          {/* Header */}
          <div>
            <SkeletonText className="mb-2 h-8 w-32" />
            <SkeletonText className="h-4 w-full max-w-md" />
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center gap-1">
                  <SkeletonBox className="h-4 w-4" delay={i * 50} />
                  <SkeletonText className="h-3 w-14" delay={i * 50} />
                </div>
                <SkeletonText className="h-7 w-14" delay={i * 50} />
              </div>
            ))}
          </div>

          {/* Daily Rewards placeholder */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-5 w-32" />
            </div>
            <SkeletonBox className="h-14 w-full rounded-lg" />
          </div>

          {/* Earn Points (tasks + share) */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-6 w-28" />
            </div>

            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <SkeletonBox className="h-5 w-5 shrink-0" delay={i * 50} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <SkeletonText className="h-4 w-28" delay={i * 50} />
                    <SkeletonText className="h-3 w-40" delay={i * 50} />
                  </div>
                  <SkeletonText className="h-4 w-12 shrink-0" delay={i * 50} />
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Referral Link */}
          <div className="rounded-lg border border-border p-4">
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <SkeletonBox className="h-5 w-5" />
                <SkeletonText className="h-5 w-28" />
              </div>
              <SkeletonText className="mt-1 h-3 w-48" />
            </div>

            <div className="space-y-3">
              <div className="flex gap-2">
                <SkeletonBox className="h-10 min-w-0 flex-1 rounded-lg" />
                <SkeletonBox className="h-10 w-[84px] shrink-0 rounded-lg" />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <SkeletonBox className="h-10 flex-1 rounded-lg" />
                <SkeletonBox className="h-10 flex-1 rounded-lg" />
              </div>
            </div>
          </div>

          {/* Referred Users List */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <SkeletonBox className="h-5 w-5" />
              <SkeletonText className="h-5 w-32" />
            </div>

            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <SkeletonBox
                    className="h-8 w-8 shrink-0 rounded-full"
                    delay={i * 50}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <SkeletonText className="h-4 w-28" delay={i * 50} />
                    <SkeletonText className="h-3 w-20" delay={i * 50} />
                  </div>
                  <SkeletonBox className="h-4 w-4" delay={i * 50} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <span className="sr-only">Loading rewards content, please wait...</span>
    </div>
  );
}
