// spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import { PageShell } from "./PageShell.tsx";

export type CheckoutOutcomeProps = {
  deploymentName: string;
  outcome: "paid" | "canceled";
};

export function CheckoutOutcome({ deploymentName, outcome }: CheckoutOutcomeProps) {
  switch (outcome) {
    case "paid":
      return (
        <PageShell title="Check the subscription" deploymentName={deploymentName}>
          <p>You can close this page. {deploymentName} shows the subscription once the payment is verified.</p>
        </PageShell>
      );
    case "canceled":
      return (
        <PageShell title="Checkout closed" deploymentName={deploymentName}>
          <p>Return to {deploymentName} to check the subscription or try again. You can close this page.</p>
        </PageShell>
      );
  }
}
