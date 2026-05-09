import { Button } from "@elizaos/cloud-ui";
import { AlertCircle, Home, RefreshCw } from "lucide-react";
import { Suspense } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

function AuthErrorContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason") || "unknown";

  const errorMessages: Record<string, { title: string; description: string }> = {
    auth_failed: {
      title: "Authentication Failed",
      description: "We could not authenticate your account. Please try signing in again.",
    },
    sync_failed: {
      title: "Authentication Sync Failed",
      description: "We could not sync your account information. Please try signing in again.",
    },
    unknown: {
      title: "Authentication Error",
      description: "An unexpected error occurred during authentication. Please try again.",
    },
  };

  const error = errorMessages[reason] || errorMessages.unknown;

  const handleLogin = () => {
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
      <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-red-500/10">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-white">{error.title}</h2>
            <p className="text-sm text-neutral-500">{error.description}</p>
          </div>

          <div className="w-full space-y-3">
            <Button
              onClick={handleLogin}
              className="w-full h-11 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
            <Button
              variant="outline"
              asChild
              className="w-full h-11 rounded-xl border-white/10 hover:bg-white/10"
            >
              <Link to="/">
                <Home className="h-4 w-4 mr-2" />
                Go Home
              </Link>
            </Button>
          </div>

          <p className="text-xs text-neutral-600">
            If this problem persists, please contact support.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Authentication error page with dynamic error messages based on reason query parameter.
 * Supports retry functionality and displays appropriate error details.
 */
export default function AuthErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
          <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
          <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-red-500/10">
                <AlertCircle className="h-7 w-7 text-red-500" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-semibold text-white">Authentication Error</h2>
                <p className="text-sm text-neutral-500">Loading error details...</p>
              </div>
            </div>
          </div>
        </div>
      }
    >
      <AuthErrorContent />
    </Suspense>
  );
}
