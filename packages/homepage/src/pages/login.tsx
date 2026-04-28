
/**
 * Login page - redirects to /get-started
 * Kept for backwards compatibility with any existing links.
 */


import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/context/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        router.replace("/connected");
      } else {
        router.replace("/get-started");
      }
    }
  }, [isAuthenticated, isLoading, router]);

  return (
    <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
      <div className="text-white/60 animate-pulse">Redirecting...</div>
    </main>
  );
}
