import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import LandingHeader from "../../components/layout/landing-header";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

function StewardLoginSectionFallback() {
  return <div aria-busy="true" className="min-h-[260px] w-full" />;
}

function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-cloud flex min-h-screen w-full flex-col bg-black text-white">
      <LandingHeader />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4 pt-24">
        <div className="w-full max-w-md border border-white/14 bg-black p-6 text-white md:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Login page — Steward is the sole auth provider.
 */
export default function LoginPage() {
  return (
    <LoginBackground>
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="font-poppins text-2xl font-semibold text-white">
            Welcome back
          </h1>
          <p className="text-sm text-white/70">
            Sign in to chat with your cloud agent and manage everything for it.
          </p>
        </div>
        <Suspense fallback={<StewardLoginSectionFallback />}>
          <StewardLoginSection />
        </Suspense>
        <p className="border-t border-white/14 pt-4 text-center text-xs text-white/60">
          By signing in, you agree to our{" "}
          <Link
            to="/terms-of-service"
            className="text-white transition-colors hover:text-[#FF5800]"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            to="/privacy-policy"
            className="text-white transition-colors hover:text-[#FF5800]"
          >
            Privacy Policy
          </Link>
        </p>
      </div>
    </LoginBackground>
  );
}
