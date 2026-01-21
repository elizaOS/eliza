"use client";

import "./globals.css";

export default function GlobalError({
  error: _error,
  reset,
}: {
  error: globalThis.Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] antialiased font-['Geist',_system-ui,_sans-serif]">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-[4rem] font-semibold leading-none">500</h1>
          <p className="text-[var(--text-muted)]">Something went wrong</p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
