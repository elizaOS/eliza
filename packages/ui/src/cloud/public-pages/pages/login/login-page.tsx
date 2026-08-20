/**
 * Login page (public) — Steward is the sole auth provider. Renders the lazy
 * Steward login section with the terms/privacy links. Listens for device-code
 * auth completion on same-origin tabs so an orphaned sign-in form does not
 * stay live after the session already finished (#18001).
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { CheckCircle2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { subscribeCloudAuthComplete } from "../../../auth/cloud-auth-complete-signal";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";
import { LoginOptionsSkeleton } from "./login-section-skeleton";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

// Chunk-load fallback with the SAME geometry as the section's own
// provider-discovery skeleton and the final option stack, so the card holds
// one height from first paint through hydration to interactive (#18256).
function StewardLoginSectionFallback() {
  return (
    <div aria-busy="true" aria-hidden="true">
      <LoginOptionsSkeleton />
    </div>
  );
}

function LoginBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-cloud relative isolate h-[100dvh] min-h-0 overflow-hidden bg-bg text-txt">
      {/* SAFE-AREA FILL (installed iOS PWA): the `bg-bg` fill is a `fixed
          inset-0` underlay, NOT a `min-h-[100dvh]` slab. On the installed
          standalone PWA the body is non-fixed (base.css / styles.css lockdown),
          so a `fixed inset-0` element's containing block IS the true visual
          viewport — it paints edge-to-edge UNDER the status bar and down to the
          home-indicator edge. A `min-h-[100dvh]` in-flow div instead starts at
          the collapsed layout-viewport top, leaving the status-bar band showing
          the black `--launch-bg` FOUC guard through (the reported "black band").
          The safe-area inset then lives EXACTLY ONCE, on the content padding
          below — this public route renders through CloudRouterShell, NOT the
          App.tsx shell column, so nothing else insets it (#15361). */}
      <div
        aria-hidden="true"
        data-testid="login-safe-area-fill"
        className="pointer-events-none fixed inset-0 z-0 bg-bg"
      />
      <div
        className="flex h-full min-h-0 w-full flex-col px-4 sm:px-6"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0px), 1rem)",
          paddingBottom: "max(env(safe-area-inset-bottom, 0px), 1rem)",
        }}
      >
        {/* Center the card vertically, but SCROLL — never clip — when it is
            taller than the viewport. A bounded `h-full min-h-0` owner plus
            `overflow-y-auto` on the scroll region and
            the card's own `my-auto` keeps the card's top reachable; a flex
            `justify-center` instead pushes the overflow above scrollTop 0, where
            it is unreachable. Regressed on short screens (Light Phone III,
            1080×1240) where the OAuth / wallet rows fell below an unscrollable
            fold — see login-page.safe-area.test.tsx. */}
        <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
          <div className="my-auto w-full max-w-lg shrink-0 rounded-2xl border border-border bg-card p-6 text-txt shadow-[0_32px_96px_-40px_rgba(0,0,0,0.58)] sm:p-8 motion-safe:animate-[shell-overlay-in_320ms_cubic-bezier(0.16,1,0.3,1)]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function sessionIdFromLoginReturnTo(returnTo: string | null): string | null {
  if (!returnTo?.trim()) return null;
  try {
    const url = new URL(returnTo, window.location.origin);
    if (!url.pathname.includes("/auth/cli-login")) return null;
    const session = url.searchParams.get("session")?.trim();
    return session || null;
  } catch (error) {
    void error;
    return null;
  }
}

function PublicLoginPage(): React.JSX.Element {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const handoffSessionId = sessionIdFromLoginReturnTo(
    searchParams.get("returnTo"),
  );
  const [handoffComplete, setHandoffComplete] = useState(false);

  usePageTitle(t("cloud.login.metaTitle", { defaultValue: "Sign In | Eliza" }));

  useEffect(() => {
    if (!handoffSessionId) return;
    return subscribeCloudAuthComplete((message) => {
      if (message.sessionId !== handoffSessionId) return;
      setHandoffComplete(true);
      try {
        window.close();
      } catch (error) {
        void error;
      }
    });
  }, [handoffSessionId]);

  if (handoffComplete) {
    return (
      <LoginBackground>
        <div className="space-y-6 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-status-success" />
          <div className="space-y-1.5">
            <h1 className="font-sans text-2xl font-semibold tracking-tight text-txt-strong">
              {t("cloud.login.handoffCompleteTitle", {
                defaultValue: "You're signed in",
              })}
            </h1>
            <p className="text-sm text-muted">
              {t("cloud.login.handoffCompleteBody", {
                defaultValue:
                  "Return to the Eliza app tab to continue. You can close this window.",
              })}
            </p>
          </div>
          <Button
            className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground"
            onClick={() => {
              try {
                window.close();
              } catch (error) {
                void error;
              }
            }}
          >
            {t("cloud.login.closeWindow", { defaultValue: "Close window" })}
          </Button>
        </div>
      </LoginBackground>
    );
  }

  return (
    <LoginBackground>
      <main className="space-y-7">
        <div className="space-y-3 text-center">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupWhite}`}
            alt="Eliza"
            className="mx-auto h-8 w-auto"
            draggable={false}
          />
          <div className="space-y-1.5">
            <h1 className="font-sans text-2xl font-semibold tracking-tight text-txt-strong">
              {t("cloud.login.signIn", {
                defaultValue: "Sign in to Eliza",
              })}
            </h1>
            <p className="text-sm text-muted">
              {t("cloud.login.tagline", {
                defaultValue: "Build and run agents from anywhere.",
              })}
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
            className="hosted-signin-focus-emphasis inline-flex min-h-touch min-w-touch items-center justify-center rounded-sm border border-transparent px-2 font-medium text-txt underline-offset-4 transition-[opacity,background-color,border-color,color] hover:underline hover:opacity-80"
          >
            {t("cloud.login.termsLink", { defaultValue: "Terms" })}
          </Link>{" "}
          {t("cloud.login.and", { defaultValue: "and" })}{" "}
          <Link
            to="/privacy-policy"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch min-w-touch items-center justify-center rounded-sm border border-transparent px-2 font-medium text-txt underline-offset-4 transition-[opacity,background-color,border-color,color] hover:underline hover:opacity-80"
          >
            {t("cloud.login.privacyPolicy", { defaultValue: "Privacy Policy" })}
          </Link>
        </p>
      </main>
    </LoginBackground>
  );
}

export default function LoginPage(): React.JSX.Element {
  return <PublicLoginPage />;
}
