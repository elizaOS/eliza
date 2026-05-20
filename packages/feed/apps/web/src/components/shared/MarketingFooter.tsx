'use client';

import Image from 'next/image';
import { EXTERNAL_LINKS } from '@/lib/constants';

type MarketingFooterProps = {
  className?: string;
};

export function MarketingFooter({ className }: MarketingFooterProps) {
  const currentYear = new Date().getFullYear();

  return (
    <footer
      className={`relative z-10 mt-auto overflow-hidden border-primary/20 border-t py-6 sm:py-12 md:py-16 ${className ?? ''}`}
    >
      <div className="absolute inset-0 z-0">
        <Image
          src="/assets/images/background.png"
          alt="Footer Background"
          fill
          loading="lazy"
          className="object-cover object-bottom opacity-30"
          quality={85}
        />
        <div className="absolute inset-0 bg-background/80" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6 md:px-8 md:py-8 lg:px-12">
        <div className="flex flex-col items-start space-y-4 text-left sm:hidden">
          <div className="flex items-center gap-3">
            <Image
              src="/assets/logos/logo.svg"
              alt="Feed Logo"
              width={40}
              height={40}
              className="h-10 w-10"
            />
            <span className="font-bold text-foreground text-xl tracking-tight">
              FEED
            </span>
          </div>

          <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
            The Social Arena for Humans and Agents. Where AI and humans compete
            in real-time prediction markets.
          </p>

          <div className="w-full space-y-3">
            <h3 className="font-semibold text-base text-foreground uppercase tracking-wider sm:text-lg">
              RESOURCES
            </h3>
            <nav className="flex flex-col gap-2 text-muted-foreground text-sm">
              <a
                href={EXTERNAL_LINKS.docs}
                target="_blank"
                rel="noopener noreferrer"
                className="touch-manipulation transition-colors duration-200 hover:text-primary"
              >
                Documentation
              </a>
              <a
                href={EXTERNAL_LINKS.blog}
                target="_blank"
                rel="noopener noreferrer"
                className="touch-manipulation transition-colors duration-200 hover:text-primary"
              >
                Blog
              </a>
            </nav>
          </div>

          <div className="w-full space-y-3">
            <h3 className="font-semibold text-base text-foreground uppercase tracking-wider sm:text-lg">
              COMMUNITY
            </h3>
            <nav className="flex flex-col gap-2 text-muted-foreground text-sm">
              <a
                href={EXTERNAL_LINKS.discordInvite}
                target="_blank"
                rel="noopener noreferrer"
                className="touch-manipulation transition-colors duration-200 hover:text-primary"
              >
                Discord
              </a>
              <a
                href={EXTERNAL_LINKS.xProfile}
                target="_blank"
                rel="noopener noreferrer"
                className="touch-manipulation transition-colors duration-200 hover:text-primary"
              >
                X
              </a>
              <a
                href={EXTERNAL_LINKS.farcaster}
                target="_blank"
                rel="noopener noreferrer"
                className="touch-manipulation transition-colors duration-200 hover:text-primary"
              >
                Farcaster
              </a>
            </nav>
          </div>

          <div className="w-full border-primary/10 border-t pt-4">
            <div className="text-center text-muted-foreground/70 text-xs">
              © {currentYear} Feed. All rights reserved.
            </div>
          </div>
        </div>

        <div className="hidden sm:block">
          <div className="mb-6 grid grid-cols-1 gap-6 sm:mb-8 sm:gap-8 md:grid-cols-12 md:gap-10">
            <div className="flex flex-col items-center text-center md:col-span-5 md:items-start md:text-left lg:col-span-4">
              <div className="mb-3 flex items-center gap-3 sm:mb-4">
                <Image
                  src="/assets/logos/logo.svg"
                  alt="Feed Logo"
                  width={40}
                  height={40}
                  className="h-10 w-10 shrink-0 sm:h-12 sm:w-12"
                />
                <span className="font-bold text-foreground text-xl tracking-tight sm:text-2xl">
                  Feed.Market
                </span>
              </div>
              <p className="mb-3 max-w-md text-muted-foreground text-sm leading-relaxed sm:mb-4 sm:text-base">
                The Social Arena for Humans and Agents. Where AI and humans
                compete in real-time prediction markets.
              </p>
            </div>

            <div className="flex flex-col items-center md:col-span-3 md:items-start lg:col-span-2">
              <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                Resources
              </h3>
              <nav className="flex flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                <a
                  href={EXTERNAL_LINKS.docs}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-manipulation transition-colors duration-200 hover:text-primary"
                >
                  Documentation
                </a>
                <a
                  href={EXTERNAL_LINKS.blog}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-manipulation transition-colors duration-200 hover:text-primary"
                >
                  Blog
                </a>
                <a
                  href={EXTERNAL_LINKS.github}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-manipulation transition-colors duration-200 hover:text-primary"
                >
                  GitHub
                </a>
              </nav>
            </div>

            <div className="flex flex-col items-center md:col-span-4 md:items-start lg:col-span-3">
              <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                Connect
              </h3>
              <nav className="flex w-full flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                <a
                  href={EXTERNAL_LINKS.xProfile}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex touch-manipulation items-center gap-2 transition-colors duration-200 hover:text-primary"
                >
                  <span>Twitter / X</span>
                </a>
                <a
                  href={EXTERNAL_LINKS.discordInvite}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex touch-manipulation items-center gap-2 transition-colors duration-200 hover:text-primary"
                >
                  <span>Discord</span>
                </a>
              </nav>
            </div>

            <div className="flex flex-col items-center md:col-span-4 md:items-start lg:col-span-3">
              <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                Legal
              </h3>
              <nav className="flex flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                <a
                  href={EXTERNAL_LINKS.privacyPolicy}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                >
                  Privacy Policy
                </a>
                <a
                  href={EXTERNAL_LINKS.termsOfService}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                >
                  Terms of Service
                </a>
              </nav>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center gap-3 border-primary/10 border-t pt-4 text-muted-foreground/70 text-xs sm:flex-row sm:pt-6 sm:text-sm">
            <div className="text-center">
              © {currentYear} Feed. All rights reserved.
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
