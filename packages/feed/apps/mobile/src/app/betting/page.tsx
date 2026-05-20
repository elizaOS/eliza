import Link from "next/link";

export default function MobileBettingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-12">
      <h1 className="font-semibold text-2xl">Betting Moved</h1>
      <p className="text-muted-foreground">
        Prediction and perp trading now live under Markets.
      </p>
      <div>
        <Link
          href="/markets"
          className="inline-flex rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          Open Markets
        </Link>
      </div>
    </main>
  );
}
