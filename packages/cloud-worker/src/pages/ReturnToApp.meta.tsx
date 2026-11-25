// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"
import type { ComponentMeta } from "vibestack/stories";
import type { ReturnToAppProps } from "./ReturnToApp.tsx";

export const meta: ComponentMeta<ReturnToAppProps> = {
  args: {
    deploymentName: "Example Cloud",
    displayName: "Example App",
    action: { kind: "open", purpose: "SignInPurpose", intentHref: "intent://www.example.test/app/auth#Intent;scheme=https;package=test.example.app;end" },
  },
  examples: {
    Billing: { action: { kind: "open", purpose: "BillingPurpose", intentHref: "intent://www.example.test/app/billing#Intent;scheme=https;package=test.example.app;end" } },
    Connected: { action: { kind: "none" } },
  },
};
