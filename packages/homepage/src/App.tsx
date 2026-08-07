/**
 * Client-side route table for the public homepage and authenticated onboarding
 * surfaces.
 */
import { BRAND_COLORS } from "@elizaos/shared/brand";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

const MarketingPage = lazy(() => import("@/pages/marketing"));
const LandingPage = lazy(() => import("@/pages/landing"));
const LoginPage = lazy(() => import("@/pages/login"));
const ConnectedPage = lazy(() => import("@/pages/connected"));
const GetStartedPage = lazy(() => import("@/pages/get-started"));
const NotFoundPage = lazy(() => import("@/pages/not-found"));
const ProfileEditPage = lazy(() => import("@/pages/profile-edit"));
const AuthedShell = lazy(() => import("@/components/authed-shell"));

function RouteFallback() {
  return (
    <main
      className="theme-app min-h-screen flex flex-col items-center justify-center px-4"
      style={{
        background: BRAND_COLORS.orange,
        color: BRAND_COLORS.black,
        fontFamily: "Geist, Arial, sans-serif",
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
          <Route path="/" element={<LandingPage />} />
          <Route path="/leaderboard" element={<LandingPage />} />
          <Route path="/downloads" element={<MarketingPage />} />
          <Route element={<AuthedShell />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/connected" element={<ConnectedPage />} />
            <Route path="/get-started" element={<GetStartedPage />} />
            <Route path="/profile/edit" element={<ProfileEditPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
