import { CloudSkyBackground } from "@elizaos/ui";
import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import LandingHeader from "../../components/layout/landing-header";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

/**
 * Lightweight Suspense placeholder shown only while the
 * StewardLoginSection chunk is in flight. Sized to match the rendered
 * section so the card doesn't visibly resize when the chunk resolves —
 * and on warm navigation (chunk already cached) the resolution happens
 * synchronously inside React's render phase, so users see nothing here.
 */
function StewardLoginSectionFallback() {
  return <div aria-busy="true" className="min-h-[260px] w-full" />;
}

// Shared Eliza sky background used by all login states.
function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <CloudSkyBackground
      className="flex min-h-screen w-full flex-col"
      contentClassName="flex min-h-screen w-full flex-col"
      intensity="soft"
    >
      <LandingHeader />

      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md rounded-[22px] border border-white/30 bg-white/24 p-6 text-white shadow-[0_28px_90px_rgba(3,28,58,0.28)] backdrop-blur-2xl md:p-8">
          {children}
        </div>
      </div>
    </CloudSkyBackground>
  );
}

/**
 * Login page — Steward is the sole auth provider.
 *
 * Suspense is scoped tightly to the Steward section so the gradient,
 * header, and copy paint immediately and don't flash through a heavy
 * "Initializing..." spinner. On warm navigation the lazy chunk is in
 * the module cache and resolves synchronously, so the fallback never
 * appears.
 */
export default function LoginPage() {
  return (
    <LoginBackground>
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold text-white">Welcome back</h1>
          <p className="text-sm text-white/78">
            Sign in to chat with your cloud agent and manage everything for it.
          </p>
        </div>
        <Suspense fallback={<StewardLoginSectionFallback />}>
          <StewardLoginSection />
        </Suspense>
        <p className="border-t border-white/20 pt-4 text-center text-xs text-white/68">
          By signing in, you agree to our{" "}
          <Link
            to="/terms-of-service"
            className="text-white/82 transition-colors hover:text-white"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            to="/privacy-policy"
            className="text-white/82 transition-colors hover:text-white"
          >
            Privacy Policy
          </Link>
        </p>
      </div>
    </LoginBackground>
  );
}
