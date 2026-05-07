import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useGallery } from "../../lib/data/gallery";
import { ImagePageClient } from "./_components/image-page-client";

/** /dashboard/image — wraps ImagePageClient with the caller's image history. */
export default function ImagePage() {
  const session = useRequireAuth();
  const enabled = session.ready && session.authenticated;
  const { data, isLoading, error } = useGallery(enabled ? { type: "image" } : undefined);

  return (
    <>
      <Helmet>
        <title>Image Studio</title>
        <meta
          name="description"
          content="Generate and manage AI images with the Eliza Cloud image studio"
        />
      </Helmet>
      {!session.ready || (enabled && isLoading) ? (
        <DashboardLoadingState label="Loading image history" />
      ) : error ? (
        <DashboardErrorState message={(error as Error).message} />
      ) : (
        <ImagePageClient initialHistory={data ?? []} />
      )}
    </>
  );
}
