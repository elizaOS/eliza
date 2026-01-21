import { PageContainer } from "@/components/shared/PageContainer";
import {
  FeedSkeleton,
  ProfileHeaderSkeleton,
} from "@/components/shared/Skeleton";

export default function ProfileLoading() {
  return (
    <PageContainer noPadding className="flex min-h-screen flex-col">
      {/* Desktop */}
      <div className="hidden flex-1 lg:flex">
        {/* Main Content */}
        <div className="flex min-w-0 flex-1 flex-col border-[rgba(120,120,120,0.5)] border-r border-l">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[700px]">
              {/* Profile Header */}
              <ProfileHeaderSkeleton />

              {/* Posts */}
              <div className="mt-4 border-border/5 border-t">
                <FeedSkeleton count={5} />
              </div>
            </div>
          </div>
        </div>

        {/* Right: Widget placeholder */}
        <div className="w-80 shrink-0 border-border/5 border-l bg-background xl:w-96" />
      </div>

      {/* Mobile/Tablet */}
      <div className="flex flex-1 overflow-y-auto lg:hidden">
        <div className="w-full">
          {/* Profile Header */}
          <ProfileHeaderSkeleton />

          {/* Posts */}
          <div className="mt-4 border-border/5 border-t">
            <FeedSkeleton count={4} />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
