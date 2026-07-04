/**
 * In-app Approvals pane: a logged-in owner approves / denies / votes on their
 * agent's pending items next to chat.
 *
 * Three tabs — Approvals (signature-gated approval requests), Sensitive
 * (per-id sensitive-request lookup + cancel), Ballots (secret ballots with
 * tally / cancel / vote). Net-new owner-facing surface: the public token pages
 * (`/approve/:id`, `/ballot/:id`, `/sensitive-requests/:id`) are the
 * sessionless recipient flow; this pane is the owner-side counterpart that lists
 * and acts on the same records via the Bearer-gated collection / owner
 * endpoints.
 *
 * Gates on the Steward session (the shell wraps non-public routes in
 * `StewardAuthProvider`; this also checks `useRequireAuth` so a signed-out user
 * sees a prompt instead of empty lists). The same {@link ApprovalsSurface} is
 * exported so a settings-section or sidebar host can embed it without the route
 * wrapper.
 */

import { useRequireAuth } from "@elizaos/ui/cloud/lib/use-session-auth";
import { DashboardLoadingState } from "@elizaos/ui/cloud-ui/components/dashboard/route-placeholders";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui/components/primitives";
import { ShieldCheck } from "lucide-react";
import { ApprovalsTab } from "./components/approvals-tab";
import { BallotsTab } from "./components/ballots-tab";
import { SensitiveTab } from "./components/sensitive-tab";

/**
 * The Approvals surface. Embeddable: used directly by an owner-facing settings
 * section / sidebar panel and wrapped by {@link ApprovalsRoute} for the
 * standalone route.
 */
export function ApprovalsSurface() {
  const { ready, authenticated } = useRequireAuth();

  if (!ready) {
    return <DashboardLoadingState label="Loading approvals" />;
  }

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-accent" />
        <h1 className="mt-4 text-lg font-semibold text-txt">
          Sign in required
        </h1>
        <p className="mt-1 text-sm text-muted">
          Log in with your Eliza Cloud account to review your agent&apos;s
          pending approvals.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-txt">Approvals</h1>
          <p className="text-sm text-muted">
            Review and act on your agent&apos;s pending requests.
          </p>
        </div>
      </header>

      <Tabs defaultValue="approvals">
        <TabsList>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="sensitive">Sensitive</TabsTrigger>
          <TabsTrigger value="ballots">Ballots</TabsTrigger>
        </TabsList>
        <TabsContent value="approvals">
          <ApprovalsTab />
        </TabsContent>
        <TabsContent value="sensitive">
          <SensitiveTab />
        </TabsContent>
        <TabsContent value="ballots">
          <BallotsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Default export consumed by the cloud-route registry. */
export default function ApprovalsRoute() {
  return <ApprovalsSurface />;
}
