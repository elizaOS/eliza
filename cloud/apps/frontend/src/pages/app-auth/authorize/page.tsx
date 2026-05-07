import { Suspense } from "react";

import { AuthorizeContent } from "@elizaos/cloud-ui/components/auth/authorize-content";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
