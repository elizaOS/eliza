// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import { createHash } from "node:crypto";
import type { ReturnPurpose } from "../../gen/cloud__nativeClients__registry.ts";

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

export const forwardScript =
  '(function(){var v={},n={},S=/^[A-Za-z0-9_-]{43}$/;function r(t){t.split("&").forEach(function(p){var i=p.indexOf("=");if(i<1)return;var k=p.slice(0,i);v[k]=n[k]?null:p.slice(i+1);n[k]=1})}r(location.hash.slice(1));r(location.search.slice(1));function g(k,R){var x=v[k];return typeof x==="string"&&R.test(x)?x:null}var a=document.getElementById("open"),p=a&&a.getAttribute("data-purpose"),s=g("state",S),f="";if(p==="SignInPurpose"&&s)f="?error=app_link_unverified&state="+s;if(p==="ConnectPurpose"){var o=g("result",/^(connected|denied|failed)$/),c=g("connectionId",/^[A-Za-z0-9_-]{1,128}$/);if(s&&o&&(o==="connected"?c:!n.connectionId))f="#state="+s+"&result="+o+(o==="connected"?"&connectionId="+c:"")}if(p==="BillingPurpose"){var q=[],i=g("session_id",/^cs_(test|live)_[A-Za-z0-9]{1,200}$/);if(i)q.push("session_id="+i);if(g("cancelled",/^1$/))q.push("cancelled=1");if(q.length)f="?"+q.join("&")}if(a&&f)a.setAttribute("href",a.getAttribute("href").replace("#Intent;",f+"#Intent;"));if(location.hash||location.search)history.replaceState(null,"",location.pathname)})();';

export const forwardScriptHash = `sha256-${createHash("sha256").update(forwardScript).digest("base64")}`;
