// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import type { ReactNode } from "react";
import { Card, CardTitle } from "@repo/ui";

export type PageShellProps = {
  title: string;
  deploymentName: string;
  children: ReactNode;
};

export function PageShell({ title, deploymentName, children }: PageShellProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md text-center">
        <CardTitle className="text-xl">{title}</CardTitle>
        {children}
        <p className="text-sm text-muted-foreground">{deploymentName}</p>
      </Card>
    </main>
  );
}
