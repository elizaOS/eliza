/**
 * Apps skeleton loading component displaying placeholder cards while apps are loading.
 */
export function AppsSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex items-center justify-between p-4 bg-white/5 rounded-lg animate-pulse"
        >
          <div className="flex items-center gap-4 flex-1">
            <div className="w-12 h-12 bg-white/10 rounded-lg" />
            <div className="space-y-2 flex-1">
              <div className="h-4 bg-white/10 rounded w-1/4" />
              <div className="h-3 bg-white/10 rounded w-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="h-8 w-20 bg-white/10 rounded" />
            <div className="h-8 w-8 bg-white/10 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
