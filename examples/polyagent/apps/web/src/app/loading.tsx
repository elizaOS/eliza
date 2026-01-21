import { Skeleton } from "@/components/shared/Skeleton";

export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-4 p-8 text-center">
        {/* Use solid bg-muted for better visibility in dark mode. */}
        <Skeleton className="mx-auto h-16 w-16 rounded-full bg-muted" />
        <Skeleton className="mx-auto h-6 w-48 max-w-full bg-muted" />
        <Skeleton className="mx-auto h-4 w-64 max-w-full bg-muted" />
      </div>
    </div>
  );
}
