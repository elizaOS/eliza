/**
 * Compatibility login route that redirects visitors to the correct homepage
 * onboarding or connected state.
 */
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  clearRememberedReturnTo,
  rememberReturnTo,
  safeReturnTo,
} from "@/lib/auth-return";
import { useAuth } from "@/lib/context/auth-context";
import { useT } from "@/providers/I18nProvider";

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const t = useT();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      const returnTo = safeReturnTo(searchParams.get("returnTo"));
      if (isAuthenticated) {
        clearRememberedReturnTo();
        navigate(returnTo ?? "/connected", { replace: true });
      } else {
        rememberReturnTo(returnTo);
        const query = returnTo
          ? `?returnTo=${encodeURIComponent(returnTo)}`
          : "";
        navigate(`/get-started${query}`, { replace: true });
      }
    }
  }, [isAuthenticated, isLoading, navigate, searchParams]);

  return (
    <main className="theme-app app-shell">
      <header className="app-header">
        <a
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="app-brand"
        >
          <img
            src="/brand/logos/eliza_wordmark_black.svg"
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            width={512}
            height={216}
            draggable={false}
            className="app-brand-mark"
          />
        </a>
      </header>
      <section
        className="brand-section brand-section--orange app-hero"
        style={{ flex: 1, display: "flex", alignItems: "center" }}
      >
        <div className="app-narrow" style={{ width: "100%" }}>
          <p className="app-eyebrow">
            {t("homepage_eliza.login.eyebrow", { defaultValue: "Sign in" })}
          </p>
          <h1 className="app-display">
            {t("homepage_eliza.login.title", { defaultValue: "Redirecting…" })}
          </h1>
          <p className="app-lede">
            {t("homepage_eliza.login.lede", {
              defaultValue: "Sending you to the right place.",
            })}
          </p>
        </div>
      </section>
    </main>
  );
}
