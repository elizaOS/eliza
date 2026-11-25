// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"
import { Button } from "@repo/ui";
import { PageShell } from "./PageShell.tsx";

export type ReturnToAppProps = {
  deploymentName: string;
  displayName: string;
  action: { kind: "open"; purpose: string; intentHref: string } | { kind: "none" };
};

export function ReturnToApp({ deploymentName, displayName, action }: ReturnToAppProps) {
  switch (action.kind) {
    case "open":
      return (
        <PageShell title={`Return to ${displayName}`} deploymentName={deploymentName}>
          <p>{displayName} did not open by itself, so nothing was finished here. Return to {displayName} to continue.</p>
          <p className="text-sm text-muted-foreground">
            If this keeps happening, open Android Settings, then Apps, {displayName}, Open by default, and allow it to open its supported links.
          </p>
          <Button asChild size="lg">
            <a id="open" data-purpose={action.purpose} href={action.intentHref}>
              Return to {displayName}
            </a>
          </Button>
        </PageShell>
      );
    case "none":
      return (
        <PageShell title="Connected" deploymentName={deploymentName}>
          <p>The connection is finished. Return to {displayName} to continue. You can close this page.</p>
        </PageShell>
      );
  }
}
