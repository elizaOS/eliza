/**
 * Shared presentation contract for the OIDC authorize and resume interstitials.
 * The tokens intentionally mirror the hosted login card so every hop retains
 * one background, geometry, typography, focus treatment, and accent behavior.
 */

import type { ReactNode } from "react";

export const OIDC_INTERSTITIAL_STYLE_TOKENS = {
  viewport:
    "theme-cloud relative flex min-h-[100dvh] w-full flex-col overflow-hidden bg-bg font-sans text-txt",
  stage: "relative z-10 flex flex-1 items-center justify-center p-4",
  card: "w-full max-w-md rounded-xl border border-border bg-card p-6 text-txt md:p-8",
  content: "flex flex-col items-center gap-6 text-center",
  heading: "font-sans text-lg font-semibold tracking-tight text-txt-strong",
  body: "max-w-sm text-center text-sm leading-relaxed text-muted",
  primaryAction:
    "hosted-signin-focus-emphasis min-h-touch rounded-md border border-transparent bg-accent px-4 font-semibold text-accent-foreground transition-[background-color,transform] hover:bg-accent-hover active:scale-[0.99]",
  secondaryAction:
    "hosted-signin-focus-emphasis min-h-touch rounded-md border border-transparent px-3 text-sm text-muted transition-colors hover:bg-bg-hover hover:text-txt",
} as const;

export function OidcInterstitialFrame({ children }: { children: ReactNode }) {
  return (
    <main
      className={OIDC_INTERSTITIAL_STYLE_TOKENS.viewport}
      data-oidc-interstitial="viewport"
    >
      <div className={OIDC_INTERSTITIAL_STYLE_TOKENS.stage}>
        <div
          className={OIDC_INTERSTITIAL_STYLE_TOKENS.card}
          data-oidc-interstitial="card"
        >
          <div
            className={OIDC_INTERSTITIAL_STYLE_TOKENS.content}
            data-oidc-interstitial="content"
          >
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
