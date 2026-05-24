/**
 * Footer component for the cloud landing page.
 * Keeps cross-product CTAs available without turning them into primary nav.
 */

"use client";

import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { useT } from "@/providers/I18nProvider";

export default function Footer() {
  const t = useT();

  return (
    <footer className="relative bg-black" style={{ flexShrink: 0 }}>
      <div className="container mx-auto px-6 py-12 relative z-10">
        <div className="grid grid-cols-2 items-start gap-8">
          <div className="flex flex-col gap-8">
            <div className="relative mr-auto flex flex-col gap-3">
              <img
                src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
                alt="Eliza Cloud"
                className="h-8 w-auto"
                draggable={false}
              />
              <p className="max-w-[16rem] text-sm leading-relaxed text-white/74">
                {t("cloud.footer.tagline", {
                  defaultValue: "Eliza, everywhere.",
                })}
              </p>
            </div>
            <nav
              aria-label={t("cloud.footer.legalAriaLabel", {
                defaultValue: "Legal",
              })}
              className="flex flex-col gap-1.5"
            >
              <a
                href="/privacy-policy"
                className="text-base text-white transition-colors hover:opacity-75"
              >
                {t("cloud.footer.privacy", { defaultValue: "Privacy" })}
              </a>
              <a
                href="/terms-of-service"
                className="text-base text-white transition-colors hover:opacity-75"
              >
                {t("cloud.footer.terms", { defaultValue: "Terms" })}
              </a>
            </nav>
          </div>

          <nav
            aria-label={t("cloud.footer.ariaLabel", {
              defaultValue: "Footer",
            })}
            className="flex flex-col gap-1.5 md:gap-2.5 text-right relative items-end"
          >
            <a
              href="https://docs.elizaos.ai/cloud"
              target="_blank"
              rel="noreferrer"
              className="text-base text-white transition-colors hover:opacity-75"
            >
              {t("cloud.footer.docs", { defaultValue: "Docs" })}
            </a>
            <a
              href={EXTERNAL_URLS.github}
              target="_blank"
              rel="noreferrer"
              className="text-base text-white transition-colors hover:opacity-75"
            >
              {t("cloud.footer.github", { defaultValue: "Github" })}
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
