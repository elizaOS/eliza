import { CloudVideoBackground } from "@elizaos/ui";
import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import LandingHeader from "../../components/layout/landing-header";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

function StewardLoginSectionFallback() {
  return <div aria-busy="true" className="min-h-[260px] w-full" />;
}

function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <CloudVideoBackground
      basePath="/clouds"
      speed="4x"
      poster="/clouds/poster.jpg"
      scrim={0.82}
      scrimColor="rgba(0,0,0,1)"
      className="theme-cloud min-h-screen bg-black text-white"
    >
      <div className="flex min-h-screen w-full flex-col">
        <LandingHeader />
        <div className="relative z-10 flex flex-1 items-center justify-center p-4 pt-24">
          <div className="w-full max-w-md border border-white/14 bg-black/86 p-6 text-white backdrop-blur-md md:p-8">
            {children}
          </div>
        </div>
      </div>
    </CloudVideoBackground>
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
          <img
            src="/brand/logos/elizacloud_logotext.svg"
            alt="eliza cloud"
            className="mx-auto h-8 w-auto"
            draggable={false}
          />
          <h1 className="font-poppins text-2xl font-semibold text-white">
            Sign in
          </h1>
          <p className="text-sm text-white/70">Run your Eliza in Cloud.</p>
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
