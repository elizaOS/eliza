import Link from "next/link";

export default function MobileApiDocsPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-12">
      <h1 className="font-semibold text-2xl">API Docs</h1>
      <p className="text-muted-foreground">
        Interactive API documentation is only available in the web app.
      </p>
      <div>
        <Link
          href="/api-docs"
          className="inline-flex rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          Open Web Docs
        </Link>
      </div>
    </main>
  );
}
