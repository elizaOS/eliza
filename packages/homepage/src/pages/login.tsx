import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/context/auth-context";
import { useT } from "@/providers/I18nProvider";

export default function LoginPage() {
  const navigate = useNavigate();
  const t = useT();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        navigate("/connected", { replace: true });
      } else {
        navigate("/get-started", { replace: true });
      }
    }
  }, [isAuthenticated, isLoading, navigate]);

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
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaBlack}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
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
