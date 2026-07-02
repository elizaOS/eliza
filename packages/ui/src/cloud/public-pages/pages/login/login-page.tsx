/**
 * Login page (public) — Steward is the sole auth provider. Renders the lazy
 * Steward login section with the terms/privacy links.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

function StewardLoginSectionFallback() {
  return <div aria-busy="true" className="min-h-[260px] w-full" />;
}

function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="theme-cloud min-h-screen bg-black text-white"
      style={{ background: "var(--background)" }}
    >
      <div className="flex min-h-screen w-full flex-col">
        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-md border border-white/14 bg-black/86 p-6 text-white md:p-8">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const t = useCloudT();
  usePageTitle(
    t("cloud.login.metaTitle", { defaultValue: "Sign In | Eliza Cloud" }),
  );
  return (
    <LoginBackground>
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
            alt="Eliza Cloud"
            className="mx-auto h-8 w-auto"
            draggable={false}
          />
          <h1 className="font-poppins text-2xl font-semibold text-white">
            {t("cloud.login.signIn", {
              defaultValue: "Sign in or create an account",
            })}
          </h1>
          <p className="text-sm text-white/70">
            {t("cloud.login.tagline", { defaultValue: "Run Eliza in Cloud." })}
          </p>
        </div>
        <Suspense fallback={<StewardLoginSectionFallback />}>
          <StewardLoginSection />
        </Suspense>
        <p className="border-t border-white/14 pt-4 text-center text-xs text-white/74">
          {t("cloud.login.agreePrefix", {
            defaultValue: "By signing in, you agree to the",
          })}{" "}
          <Link
            to="/terms-of-service"
            className="text-white transition-colors hover:opacity-80"
          >
            {t("cloud.login.termsLink", { defaultValue: "Terms" })}
          </Link>{" "}
          {t("cloud.login.and", { defaultValue: "and" })}{" "}
          <Link
            to="/privacy-policy"
            className="text-white transition-colors hover:opacity-80"
          >
            {t("cloud.login.privacyPolicy", { defaultValue: "Privacy Policy" })}
          </Link>
        </p>
      </div>
    </LoginBackground>
  );
}
