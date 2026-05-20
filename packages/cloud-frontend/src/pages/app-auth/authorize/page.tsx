import { AuthorizeContent } from "@elizaos/ui";
import { Suspense } from "react";
import { Helmet } from "react-helmet-async";

export default function AppAuthAuthorizePage() {
  return (
    <>
      <Helmet>
        <title>Authorize App | Eliza Cloud</title>
      </Helmet>
      <Suspense fallback={null}>
        <AuthorizeContent />
      </Suspense>
    </>
  );
}
