/** Explains deletion policy and routes authenticated users into the deletion flow. */

import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { AccountDeletionDialog } from "../../../account-security/components/account-deletion-dialog";
import { useSessionAuth } from "../../../lib/use-session-auth";
import { usePageTitle } from "../../lib/use-page-title";

export default function AccountDeletionPage() {
  usePageTitle("Delete your Eliza account | Eliza Cloud");
  const session = useSessionAuth();

  return (
    <div
      className="theme-cloud h-[100dvh] overflow-y-auto bg-bg px-6 py-16 font-sans text-txt sm:px-8"
      data-scroll-cert-scroller
    >
      <main className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-3 border-b border-border pb-6">
          <p className="text-sm font-medium text-accent">
            Eliza Cloud account deletion
          </p>
          <h1 className="text-4xl font-bold tracking-tight">
            Delete your account and data
          </h1>
          <p className="leading-relaxed text-muted-strong">
            This page is the web deletion-request path for the Eliza Android app
            and Eliza Cloud.
          </p>
        </div>

        <section className="space-y-5 rounded-lg border border-border bg-bg-elevated p-6">
          <ShieldCheck className="h-7 w-7 text-accent" />
          <h2 className="text-xl font-semibold">Submit a verified request</h2>
          <p className="text-muted-strong">
            Sign in to verify ownership and check whether the complete,
            recoverable deletion lifecycle is available for your account. The
            page shows an accepted request only after the server returns a
            verified receipt.
          </p>
          {!session.ready ? (
            <p className="text-sm text-muted">Checking your session…</p>
          ) : session.authenticated ? (
            <AccountDeletionDialog />
          ) : (
            <Link
              to="/login?returnTo=%2Faccount-deletion"
              className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
            >
              Sign in to request deletion
            </Link>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">What is deleted</h2>
          <p className="leading-relaxed text-muted-strong">
            Your Eliza login identity, profile, sessions, API keys, personal
            conversations, agents, connectors, and other data associated only
            with your account are deleted. Content owned by a shared
            organization remains with that organization after ownership is
            transferred.
          </p>
          <p className="leading-relaxed text-muted-strong">
            Limited billing, transaction, fraud-prevention, security, or legal
            records may be retained when required, then deleted or anonymized
            when that obligation ends.
          </p>
        </section>

        <section className="space-y-3 border-t border-border pt-6">
          <h2 className="text-xl font-semibold">Cannot sign in?</h2>
          <p className="text-muted-strong">
            Email{" "}
            <a
              className="underline"
              href="mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request"
            >
              support@eliza.cloud
            </a>{" "}
            from the address on your account. Include only your account email
            and the words “account deletion request.” Never send a password, API
            key, recovery code, or wallet secret.
          </p>
          <div className="flex gap-4 text-sm">
            <Link className="underline" to="/privacy-policy">
              Privacy Policy
            </Link>
            <Link className="underline" to="/terms-of-service">
              Terms of Service
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
