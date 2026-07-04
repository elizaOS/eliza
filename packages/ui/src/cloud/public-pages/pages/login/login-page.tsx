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
  return (
    <div className="space-y-4" aria-busy="true" aria-hidden="true">
      <div className="h-touch w-full rounded-md bg-bg-muted" />
      <div className="flex gap-2">
        <div className="h-touch flex-1 rounded-md bg-bg-muted" />
        <div className="h-touch flex-1 rounded-md bg-bg-muted" />
      </div>
      <div className="mx-auto h-3 w-3/4 rounded-full bg-bg-muted" />
    </div>
  );
}

function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-cloud min-h-[100dvh] bg-bg text-txt">
      <div
        className="flex min-h-[100dvh] w-full flex-col px-4"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0px), 1rem)",
          paddingBottom: "max(env(safe-area-inset-bottom, 0px), 1rem)",
        }}
      >
        <div className="relative z-10 flex flex-1 items-center justify-center">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-txt md:p-8 motion-safe:animate-[shell-overlay-in_320ms_cubic-bezier(0.16,1,0.3,1)]">
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
      <div className="space-y-8">
        <div className="space-y-3 text-center">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
            alt="Eliza Cloud"
            className="mx-auto h-8 w-auto"
            draggable={false}
          />
          <div className="space-y-1.5">
            <h1 className="font-sans text-2xl font-semibold tracking-tight text-txt-strong">
              {t("cloud.login.signIn", {
                defaultValue: "Sign in or create an account",
              })}
            </h1>
            <p className="text-sm text-muted">
              {t("cloud.login.tagline", { defaultValue: "Run Eliza in Cloud." })}
            </p>
          </div>
        </div>
        <Suspense fallback={<StewardLoginSectionFallback />}>
          <StewardLoginSection />
        </Suspense>
        <p className="border-t border-border pt-5 text-center text-xs leading-relaxed text-muted">
          {t("cloud.login.agreePrefix", {
            defaultValue: "By signing in, you agree to the",
          })}{" "}
          <Link
            to="/terms-of-service"
            className="font-medium text-txt underline-offset-4 transition-opacity hover:underline hover:opacity-80"
          >
            {t("cloud.login.termsLink", { defaultValue: "Terms" })}
          </Link>{" "}
          {t("cloud.login.and", { defaultValue: "and" })}{" "}
          <Link
            to="/privacy-policy"
            className="font-medium text-txt underline-offset-4 transition-opacity hover:underline hover:opacity-80"
          >
            {t("cloud.login.privacyPolicy", { defaultValue: "Privacy Policy" })}
          </Link>
        </p>
      </div>
    </LoginBackground>
  );
}
