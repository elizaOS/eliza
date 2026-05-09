import {
  DocsLayout,
  type MdxModule,
} from "@elizaos/cloud-ui";
import { type ReactElement, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import { docsNav, mdxLoaders } from "./nav";

function DocsLoading() {
  return <div className="docs-loading">Loading…</div>;
}

function DocsNotFound({ path }: { path: string }) {
  return (
    <div className="docs-notfound">
      <h1>Page Not Found</h1>
      <p>
        <code>{path}</code> isn&apos;t part of the docs.
      </p>
    </div>
  );
}

export default function DocsRouter() {
  const { pathname } = useLocation();
  const key = pathname.replace(/\/$/, "") || "/docs";
  const loader = mdxLoaders.get(key);

  const [mod, setMod] = useState<MdxModule | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setMod(null);
    setError(null);
    if (!loader) return;
    let cancelled = false;
    loader().then(
      (m) => {
        if (!cancelled) setMod(m);
      },
      (err: Error) => {
        if (!cancelled) setError(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loader]);

  let body: ReactElement;
  if (!loader) {
    body = <DocsNotFound path={pathname} />;
  } else if (error) {
    body = (
      <div className="docs-error">
        <h1>Failed to load page</h1>
        <pre>{error.message}</pre>
      </div>
    );
  } else if (!mod) {
    body = <DocsLoading />;
  } else {
    const Page = mod.default;
    body = <Page />;
  }

  const title = mod?.frontmatter?.title;
  const description = mod?.frontmatter?.description;

  return (
    <>
      <Helmet>
        <title>
          {title ? `${title} | Eliza Cloud Docs` : "Eliza Cloud Docs"}
        </title>
        {description ? <meta name="description" content={description} /> : null}
      </Helmet>
      <DocsLayout navItems={docsNav}>
        <article className="docs-article">{body}</article>
      </DocsLayout>
    </>
  );
}
