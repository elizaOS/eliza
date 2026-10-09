/** Public subscription comparison backed by the same verified catalog rendered in account billing. */
import { Button } from "../../components/ui/button";
import { SubscriptionPlans } from "./components/subscription-plans";

export default function PricingPage() {
  // The app root clips overflow, so the page owns its vertical scroll region;
  // otherwise the renewal disclosure and billing link are unreachable on
  // mobile viewports once both plans render.
  return (
    <div
      className="h-[100dvh] w-full overflow-y-auto"
      data-testid="pricing-page-scroll"
    >
      <main className="mx-auto w-full max-w-4xl px-4 py-12 md:px-6">
        <h1 className="text-3xl font-semibold mb-8">Eliza pricing</h1>
        <SubscriptionPlans />
        <Button asChild>
          <a href="/cloud/billing">Open billing</a>
        </Button>
      </main>
    </div>
  );
}
