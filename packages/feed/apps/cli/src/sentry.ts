/**
 * Sentry wiring for the Feed CLI: initializes the `@sentry/bun` client per
 * command run and flushes captured exceptions before the process exits.
 * No-ops when `DISABLE_SENTRY=true` or no `SENTRY_DSN` is configured, so local
 * and CI runs stay silent. Release is derived from Sentry/Vercel commit-sha env vars.
 */

import * as Sentry from "@sentry/bun";

type CliSentryContext = {
  domain?: string;
  command?: string;
};

function isSentryDisabled(): boolean {
  return process.env.DISABLE_SENTRY === "true";
}

function hasDsn(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}
function resolveCliRelease(): string | undefined {
  return (
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
  );
}

export function initCliSentry(context: CliSentryContext): void {
  if (isSentryDisabled() || !hasDsn()) {
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    release: resolveCliRelease(),
    tracesSampleRate: 0,
  });

  Sentry.setTag("surface", "cli");
  if (context.domain) Sentry.setTag("cli.domain", context.domain);
  if (context.command) Sentry.setTag("cli.command", context.command);
}

export async function captureCliExceptionAndFlush(
  error: unknown,
  context: CliSentryContext,
): Promise<void> {
  if (isSentryDisabled() || !hasDsn()) {
    return;
  }

  const normalized =
    error instanceof Error ? error : new Error(error ? String(error) : "Error");

  Sentry.withScope((scope) => {
    scope.setTag("surface", "cli");
    if (context.domain) scope.setTag("cli.domain", context.domain);
    if (context.command) scope.setTag("cli.command", context.command);
    scope.setContext("cli", {
      domain: context.domain,
      command: context.command,
    });

    Sentry.captureException(normalized);
  });

  await Sentry.flush(2000);
}
