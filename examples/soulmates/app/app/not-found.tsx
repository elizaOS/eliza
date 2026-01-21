export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--bg-primary)] px-6 text-center text-[var(--text-primary)]">
      <h1 className="text-[4rem] font-semibold leading-none">404</h1>
      <p className="text-[var(--text-muted)]">Page not found</p>
      <a
        href="/"
        className="text-sm font-semibold text-[var(--accent)] transition hover:text-[var(--accent-hover)] hover:underline"
      >
        Go home
      </a>
    </div>
  );
}
