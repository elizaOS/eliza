import type { NextPageContext } from "next";

interface ErrorProps {
  statusCode: number;
}

function ErrorPage({ statusCode }: ErrorProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--bg-primary)] px-6 text-center text-[var(--text-primary)]">
      <h1 className="text-[4rem] font-semibold leading-none">{statusCode}</h1>
      <p className="text-[var(--text-muted)]">
        {statusCode === 404
          ? "Page not found"
          : "An error occurred on the server"}
      </p>
      <a
        href="/"
        className="text-sm font-semibold text-[var(--accent)] transition hover:text-[var(--accent-hover)] hover:underline"
      >
        Go home
      </a>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
