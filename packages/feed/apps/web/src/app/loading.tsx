import { PageContainer } from "@/components/shared/PageContainer";
import { FeedLayoutSkeleton } from "@/components/shared/Skeleton";

export default function RootLoading() {
  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <FeedLayoutSkeleton />
    </PageContainer>
  );
}
