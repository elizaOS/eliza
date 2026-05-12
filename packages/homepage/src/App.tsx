import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthProvider } from "@/lib/context/auth-context";

const MarketingPage = lazy(() => import("@/pages/marketing"));
const LeaderboardPage = lazy(() => import("@/pages/leaderboard"));
const LoginPage = lazy(() => import("@/pages/login"));
const ConnectedPage = lazy(() => import("@/pages/connected"));
const GetStartedPage = lazy(() => import("@/pages/get-started"));

function RouteFallback() {
  return (
    <main className="min-h-screen bg-[#0d0d0f] flex flex-col items-center justify-center px-4">
      <div className="text-white/60 animate-pulse">Loading...</div>
    </main>
  );
}

export function App() {
  return (
    <QueryProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<MarketingPage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/connected" element={<ConnectedPage />} />
              <Route path="/get-started" element={<GetStartedPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </QueryProvider>
  );
}
