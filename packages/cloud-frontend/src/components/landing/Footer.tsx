/**
 * Footer component for the cloud landing page.
 * Keeps cross-product CTAs available without turning them into primary nav.
 */

"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { Link } from "react-router-dom";

export default function Footer() {
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
                Eliza, everywhere.
              </p>
            </div>
            <p className="text-sm text-white/70 whitespace-nowrap">
              © 2026 eliza cloud · USA
            </p>
          </div>

          <div className="flex flex-col gap-1 md:gap-2 items-end">
            <div className="flex flex-col gap-1.5 text-right relative">
              <a
                href="https://eliza.app"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Get App
              </a>
              <a
                href="https://elizaos.ai"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Install elizaOS
              </a>
            </div>

            <nav
              aria-label="Footer"
              className="mt-4 flex flex-col gap-1.5 md:gap-2.5 text-right relative"
            >
              <Link
                to="/docs"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Docs
              </Link>
              <a
                href="/privacy-policy"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Privacy
              </a>
              <a
                href="/terms-of-service"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Terms
              </a>
            </nav>
          </div>
        </div>
      </div>
    </footer>
  );
}
