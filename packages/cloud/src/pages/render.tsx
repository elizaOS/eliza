// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutOutcome } from "./CheckoutOutcome.tsx";
import { forwardScript, pageFile, pageSlots, type PageTemplate } from "./forward-script.ts";
import { ReturnToApp } from "./ReturnToApp.tsx";

const documentOf = (css: string, title: string, body: ReactNode, script: boolean): string =>
  "<!doctype html>" +
  renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <title>{title}</title>
        <style>{css}</style>
      </head>
      <body>
        {body}
        {script && <script>{forwardScript}</script>}
      </body>
    </html>,
  );

const pages: ReadonlyArray<readonly [PageTemplate, (css: string) => string]> = [
  [
    { kind: "returnToApp", purpose: "SignInPurpose" },
    (css) => documentOf(css, `Return to ${pageSlots.displayName}`, <ReturnToApp deploymentName={pageSlots.deploymentName} displayName={pageSlots.displayName} action={{ kind: "open", purpose: pageSlots.purpose, intentHref: pageSlots.intentHref }} />, true),
  ],
  [
    { kind: "returnToAppConnected" },
    (css) => documentOf(css, "Connected", <ReturnToApp deploymentName={pageSlots.deploymentName} displayName={pageSlots.displayName} action={{ kind: "none" }} />, true),
  ],
  [
    { kind: "checkoutOutcome", outcome: "paid" },
    (css) => documentOf(css, "Check the subscription", <CheckoutOutcome deploymentName={pageSlots.deploymentName} outcome="paid" />, false),
  ],
  [
    { kind: "checkoutOutcome", outcome: "canceled" },
    (css) => documentOf(css, "Checkout closed", <CheckoutOutcome deploymentName={pageSlots.deploymentName} outcome="canceled" />, false),
  ],
];

export const renderPages = (css: string): ReadonlyArray<{ fileName: string; source: string }> =>
  pages.map(([template, render]) => ({ fileName: pageFile(template), source: render(css) }));
