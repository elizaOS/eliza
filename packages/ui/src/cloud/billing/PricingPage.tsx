/** Public subscription comparison backed by the same verified catalog rendered in account billing. */
import { Button } from "../../components/ui/button";
import { SubscriptionPlans } from "./components/subscription-plans";

export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-12 md:px-6">
      <h1 className="text-3xl font-semibold mb-8">Eliza pricing</h1>
      <SubscriptionPlans />
      <Button asChild>
        <a href="/cloud/billing">Open billing</a>
      </Button>
    </main>
  );
}
