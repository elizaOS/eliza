import { Link } from "react-router-dom";

export function formatDashboardRouteErrorMessage(error: Error | string | null | undefined): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred while loading this page.";
}

/**
 * Dashboard route error fallback. Used with a React error boundary around
 * dashboard routes when not using a data router.
 */
export function DashboardRouteError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-white">
      <div className="flex items-center justify-center w-16 h-16 border border-red-500/25 bg-red-500/10">
        <svg
          className="h-8 w-8 text-red-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
          />
        </svg>
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-white/50 max-w-md">{message}</p>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm border border-[#FF5800]/40 bg-[#FF5800]/10 text-[#FF5800] hover:bg-[#FF5800]/20 transition-colors"
        >
          Try again
        </button>
        <Link
          to="/dashboard/agents"
          className="px-4 py-2 text-sm border border-white/10 bg-white/5 text-white/70 hover:bg-white/10 transition-colors"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
