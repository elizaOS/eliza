import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import LandingHeader from "@elizaos/cloud-ui/components/layout/landing-header";

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

// Shared gradient background used by all login states
function GradientBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-black">
      <LandingHeader />

      <div
        className="absolute inset-0"
        style={{
          backgroundColor: "hsla(167,0%,0%,1)",
          backgroundImage: `
            radial-gradient(at 72% 68%, hsla(6,56%,26%,1) 0px, transparent 50%),
            radial-gradient(at 50% 48%, hsla(10,60%,43%,0.7) 0px, transparent 50%),
            radial-gradient(at 98% 99%, hsla(19,48%,57%,1) 0px, transparent 50%),
            radial-gradient(at 14% 4%, hsla(14,90%,42%,1) 0px, transparent 50%),
            radial-gradient(at 34% 34%, hsla(15,72%,53%,1) 0px, transparent 50%)
          `,
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 invert"
          style={{
            mixBlendMode: "overlay",
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
            opacity: 1,
          }}
        />
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md bg-neutral-900/90 border border-white/10 rounded-2xl p-6 md:p-8">
          {children}
        </div>
      </div>
    </div>
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
    <GradientBackground>
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold text-white">Welcome back</h1>
          <p className="text-sm text-neutral-500">Sign in to your Eliza Cloud account</p>
        </div>
        <Suspense fallback={<StewardLoginSectionFallback />}>
          <StewardLoginSection />
        </Suspense>
        <p className="text-center text-xs text-neutral-500 pt-4 border-t border-white/10">
          By signing in, you agree to our{" "}
          <Link
            to="/terms-of-service"
            className="text-neutral-400 hover:text-white transition-colors"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            to="/privacy-policy"
            className="text-neutral-400 hover:text-white transition-colors"
          >
            Privacy Policy
          </Link>
        </p>
      </div>
    </GradientBackground>
  );
}
