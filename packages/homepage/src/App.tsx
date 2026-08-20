/**
 * Client-side route table for the public homepage and authenticated onboarding
 * surfaces.
 */
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { getLegacyOnboardingRedirect } from "@/lib/legacy-onboarding-redirect";
import LandingPage from "@/pages/landing";

const MarketingPage = lazy(() => import("@/pages/marketing"));
const DemoScenariosPage = import.meta.env.DEV
  ? lazy(() => import("@/pages/demo-scenarios"))
  : null;
const LoginPage = lazy(() => import("@/pages/login"));
const ConnectedPage = lazy(() => import("@/pages/connected"));
const GetStartedPage = lazy(() => import("@/pages/get-started"));
const NotFoundPage = lazy(() => import("@/pages/not-found"));
const ProfileEditPage = lazy(() => import("@/pages/profile-edit"));
const AuthedShell = lazy(() => import("@/components/authed-shell"));

/**
 * Blank neutral surface for lazy route transitions. The landing route imports
 * eagerly and never shows this; secondary routes get a quiet background-matched
 * frame instead of a spinner so navigation paints in one visual step.
 */
function RouteFallback() {
  return (
    <main
      className="theme-app min-h-screen"
      style={{ background: "#fdfaf7" }}
    />
  );
}

function GetStartedRoute() {
  const redirectUrl =
    typeof window === "undefined"
      ? null
      : getLegacyOnboardingRedirect(window.location);

  useEffect(() => {
    if (redirectUrl) {
      window.location.replace(redirectUrl);
    }
  }, [redirectUrl]);

  return redirectUrl ? <RouteFallback /> : <GetStartedPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/leaderboard" element={<LandingPage />} />
          {DemoScenariosPage ? (
            <Route path="/demo-scenarios" element={<DemoScenariosPage />} />
          ) : null}
          <Route path="/downloads" element={<MarketingPage />} />
          <Route element={<AuthedShell />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/connected" element={<ConnectedPage />} />
            <Route path="/get-started" element={<GetStartedRoute />} />
            <Route path="/profile/edit" element={<ProfileEditPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
