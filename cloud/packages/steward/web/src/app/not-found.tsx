import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="text-center">
        <h1 className="font-display text-4xl font-700 tracking-tight mb-2">404</h1>
        <p className="text-sm text-text-tertiary mb-6">Page not found</p>
        <Link
          href="/"
          className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors font-medium"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
