import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/context/auth-context";

export default function LoginPage() {
  const navigate = useNavigate();
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
        <a href="/" aria-label="Eliza home" className="app-brand">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaBlack}`}
            alt="Eliza"
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
          <p className="app-eyebrow">Sign in</p>
          <h1 className="app-display">Redirecting…</h1>
          <p className="app-lede">Sending you to the right place.</p>
        </div>
      </section>
    </main>
  );
}
