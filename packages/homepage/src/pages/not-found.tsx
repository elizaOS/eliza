/**
 * Catch-all page for unknown routes. Previously unmatched paths rendered a
 * blank orange shell (no route matched, so nothing painted), which read as a
 * broken page. This gives visitors a branded dead-end with a way home.
 */
import { BRAND_COLORS } from "@elizaos/shared/brand";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import { useT } from "@/providers/I18nProvider";

export default function NotFoundPage() {
  const t = useT();
  return (
    <main
      className="theme-app min-h-screen flex flex-col"
      style={{
        background: BRAND_COLORS.orange,
        color: BRAND_COLORS.black,
        fontFamily: "Geist, Arial, sans-serif",
      }}
    >
      <header className="p-4 flex items-center justify-center">
        <Link
          to="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="inline-flex items-center"
        >
          <ElizaLogo variant="svg" className="h-8 w-auto" />
        </Link>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center px-4 pb-20 text-center">
        <p className="text-sm font-medium uppercase tracking-widest opacity-70 mb-3">
          {t("homepage_eliza.notFound.eyebrow", { defaultValue: "404" })}
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold mb-3">
          {t("homepage_eliza.notFound.title", {
            defaultValue: "This page doesn't exist.",
          })}
        </h1>
        <p className="text-sm opacity-80 mb-8 max-w-sm">
          {t("homepage_eliza.notFound.subtitle", {
            defaultValue:
              "The link may be old or mistyped. Head back home to find Eliza.",
          })}
        </p>
        <Link
          to="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-xs bg-black px-5 py-3 text-sm font-medium text-white transition-opacity hover:opacity-80"
        >
          <ArrowLeft className="size-4" />
          {t("homepage_eliza.notFound.cta", { defaultValue: "Back to home" })}
        </Link>
      </div>
      <footer className="p-4 text-center text-xs opacity-60">
        {t("homepage_eliza.common.year", {
          defaultValue: "ElizaCloud Inc. {{year}}",
          year: String(new Date().getFullYear()),
        })}
      </footer>
    </main>
  );
}
