/** Storybook states for the shared public authentication result shell. */

import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "../../../../components/primitives";
import { AuthResultShell } from "./auth-result-shell";

const meta = {
  title: "Cloud/Public/AuthResultShell",
  component: AuthResultShell,
  tags: ["autodocs"],
  args: {
    children: (
      <>
        <div className="flex size-14 items-center justify-center bg-status-success-bg">
          <CheckCircle className="size-7 text-status-success" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-txt">Account connected</h1>
          <p className="text-sm text-muted">Return to the app to continue.</p>
        </div>
      </>
    ),
  },
} satisfies Meta<typeof AuthResultShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Pending: Story = {
  args: {
    children: (
      <>
        <div className="flex size-14 items-center justify-center bg-bg-muted">
          <Loader2 className="size-7 animate-spin text-muted" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-txt">
            Verifying connection
          </h1>
          <p className="text-sm text-muted">Confirming this connection…</p>
        </div>
      </>
    ),
  },
};

export const ErrorState: Story = {
  args: {
    children: (
      <>
        <div className="flex size-14 items-center justify-center bg-destructive-subtle">
          <AlertCircle className="size-7 text-destructive" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-txt">
            Authentication failed
          </h1>
          <p className="text-sm text-muted">Please try signing in again.</p>
        </div>
        <div className="w-full space-y-3">
          <Button className="h-11 w-full">Try again</Button>
          <Button className="h-11 w-full" variant="outline">
            Go home
          </Button>
        </div>
        <p className="text-xs text-muted">
          If this problem persists, please contact support.
        </p>
      </>
    ),
  },
};
