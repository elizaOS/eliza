import { DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { GalleryPageClient } from "./_components/gallery-page-client";

/** /dashboard/gallery — GalleryPageClient self-fetches via /api/v1/gallery. */
export default function GalleryPage() {
  const session = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>Gallery</title>
        <meta
          name="description"
          content="View and manage all your AI-generated content including images and videos"
        />
      </Helmet>
      {!session.ready ? <DashboardLoadingState label="Loading gallery" /> : <GalleryPageClient />}
    </>
  );
}
