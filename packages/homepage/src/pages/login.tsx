/**
 * Login page - redirects to /get-started
 * Kept for backwards compatibility with any existing links.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/context/auth-context";

export default function LoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        navigate("/connected", { replace: true });
      } else {
        navigate("/get-started", { replace: true });
      }
    }
  }, [isAuthenticated, isLoading, navigate]);

  return (
    <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
      <div className="text-white/60 animate-pulse">Redirecting...</div>
    </main>
  );
}
