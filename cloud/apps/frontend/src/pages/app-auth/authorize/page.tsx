import { Suspense } from "react";

import { AuthorizeContent } from "@elizaos/cloud-ui";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
