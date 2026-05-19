import { BRAND_COLORS } from "@elizaos/shared/brand";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

const MarketingPage = lazy(() => import("@/pages/marketing"));
const LeaderboardPage = lazy(() => import("@/pages/leaderboard"));
const LoginPage = lazy(() => import("@/pages/login"));
const ConnectedPage = lazy(() => import("@/pages/connected"));
const GetStartedPage = lazy(() => import("@/pages/get-started"));
const AuthedShell = lazy(() => import("@/components/authed-shell"));

function RouteFallback() {
  return (
    <main
      className="theme-app min-h-screen flex flex-col items-center justify-center px-4"
      style={{
        background: BRAND_COLORS.orange,
        color: BRAND_COLORS.black,
        fontFamily: "Poppins",
      }}
    >
      <Loader2 className="h-8 w-8 animate-spin opacity-80" />
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<MarketingPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route element={<AuthedShell />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/connected" element={<ConnectedPage />} />
            <Route path="/get-started" element={<GetStartedPage />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
