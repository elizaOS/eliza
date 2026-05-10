/**
 * Footer component for the landing page.
 * Displays navigation links, social links, and branding with decorative background image.
 */

"use client";

import { ElizaCloudLockup, Image } from "@elizaos/cloud-ui";
import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="relative border-t border-neutral-800 bg-black" style={{ flexShrink: 0 }}>
      <div className="container mx-auto px-6 py-8 md:py-16 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-8 items-start">
          {/* 1. Left section (Text/Copyright) */}
          <div className="flex flex-col gap-8">
            <div className="relative mr-auto flex flex-col gap-3">
              <ElizaCloudLockup logoClassName="h-5 sm:h-6" />
              <p className="max-w-[16rem] text-xs uppercase tracking-[0.28em] text-white/35">
                Agent infrastructure, billing, and deployment
              </p>
            </div>
            <p className="text-sm text-white/60 whitespace-nowrap">© 2026 ELIZA CLOUD · USA</p>
          </div>

          <div className="hidden md:flex justify-center">
            <Image
              src="/eliza-footer.png"
              alt="Footer Decorative Image"
              height={160}
              width={160}
              className="w-40 h-auto"
              draggable={false}
            />
          </div>

          {/* 3. Right section (Navigation/Social Icons) */}
          <div className="flex flex-col gap-1 md:gap-2 items-end">
            {/* Navigation */}
            <nav className="flex flex-col gap-1.5 md:gap-2.5 text-right relative">
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

            {/* Social icons */}
            <div className="mt-8 flex items-center gap-2.5 md:gap-5">
              <a
                href="https://github.com/elizaos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="GitHub"
              >
                <svg className="size-6 md:size-7" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
              <a
                href="https://discord.gg/mPsBnEXJuA"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="Discord"
              >
                <svg className="size-6 md:size-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
              <a
                href="https://x.com/elizaos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="X (Twitter)"
              >
                <svg className="size-6 md:size-7" fill="currentColor" viewBox="0 0 50 50">
                  <path d="M 5.9199219 6 L 20.582031 27.375 L 6.2304688 44 L 9.4101562 44 L 21.986328 29.421875 L 31.986328 44 L 44 44 L 28.681641 21.669922 L 42.199219 6 L 39.029297 6 L 27.275391 19.617188 L 17.933594 6 L 5.9199219 6 z M 9.7167969 8 L 16.880859 8 L 40.203125 42 L 33.039062 42 L 9.7167969 8 z"></path>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
