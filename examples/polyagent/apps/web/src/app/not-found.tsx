import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 py-24 text-center">
      <div className="rounded-full border border-yellow-500/50 bg-yellow-500/10 px-4 py-1 font-medium text-sm text-yellow-600">
        404 · Not Found
      </div>
      <h1 className="font-semibold text-4xl text-white tracking-tight">
        We couldn&apos;t find that page
      </h1>
      <p className="text-base text-white/70">
        The route you requested no longer exists or never did. Return to the
        Polyagent dashboard and keep trading.
      </p>
      <Link
        href="/"
        className="rounded-full bg-white/10 px-6 py-2 font-semibold text-sm text-white transition hover:bg-white/20"
      >
        Back to home
      </Link>
    </div>
  );
}
