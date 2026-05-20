/**
 * Offline fallback page.
 *
 * Shown by the service worker when a navigation request fails
 * and there is no cached response. Feed requires a live
 * connection for real-time prediction markets.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0a0a0a] px-8 text-[#fafafa] md:min-h-screen">
      <div className="max-w-[400px] text-center">
        <svg
          className="mx-auto mb-6 h-20 w-20 opacity-50"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
        <h1 className="mb-3 font-semibold text-2xl">You're Offline</h1>
        <p className="mb-8 text-[#a1a1aa] leading-relaxed">
          Feed requires an internet connection for real-time prediction
          markets and live events.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-[#0066FF] px-8 py-3 font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
