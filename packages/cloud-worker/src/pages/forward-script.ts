// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import { createHash } from "node:crypto";
import type { ReturnPurpose } from "../../gen/cloud__nativeClients__registry.ts";
import { forwardScript } from "./pinned-script.ts";

export type PageTemplate =
  | { readonly kind: "returnToApp"; readonly purpose: ReturnPurpose }
  | { readonly kind: "returnToAppConnected" }
  | { readonly kind: "checkoutOutcome"; readonly outcome: "paid" | "canceled" };

export const pageSlots = {
  deploymentName: "{{deploymentName}}",
  displayName: "{{displayName}}",
  intentHref: "{{intentHref}}",
  purpose: "{{purpose}}",
} as const;

export type PageSlot = keyof typeof pageSlots;

export const pageFile = (template: PageTemplate): string => {
  switch (template.kind) {
    case "returnToApp":
      return "return-to-app.html";
    case "returnToAppConnected":
      return "return-to-app.connected.html";
    case "checkoutOutcome":
      return `checkout-outcome.${template.outcome}.html`;
  }
};

export { forwardScript };

export const forwardScriptHash = `sha256-${createHash("sha256").update(forwardScript).digest("base64")}`;

/** @throws {never} */
export const styleHashes = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((found) => `'sha256-${createHash("sha256").update(found[1] ?? "").digest("base64")}'`);
