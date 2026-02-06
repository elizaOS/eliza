import { importPage } from "nextra/pages";

// Skip static generation - render docs on-demand to avoid 30+ min build times
export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  // Handle root path - mdxPath will be undefined or empty for /docs
  const path = params.mdxPath ?? [];
  const { metadata } = await importPage(path);
  return metadata;
}

type PageProps = {
  params: Promise<{
    mdxPath?: string[];
  }>;
};

export default async function Page(props: PageProps) {
  const params = await props.params;
  // Handle root path - mdxPath will be undefined or empty for /docs
  const path = params.mdxPath ?? [];
  const result = await importPage(path);
  const { default: MDXContent } = result;

  // The docs landing page (content/index.mdx) is designed to be full-width and
  // already applies its own padding/max-width via `.docs-hero` / `.docs-section`.
  // Wrapping it in the standard article container causes double padding + narrow layout.
  const isDocsLanding =
    path.length === 0 || (path.length === 1 && path[0] === "index");

  // Nextra's MDX wrapper is not guaranteed to be present in the compiled output here.
  // Provide a stable content container so docs pages have consistent padding/max-width.
  if (isDocsLanding) {
    return (
      <main className="nextra-content-container docs-landing">
        <MDXContent {...props} params={params} />
      </main>
    );
  }

  return (
    <main className="nextra-content-container">
      <article className="nextra-content">
        <MDXContent {...props} params={params} />
      </article>
    </main>
  );
}
