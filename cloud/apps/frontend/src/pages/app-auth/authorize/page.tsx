import { AuthorizeContent } from "@elizaos/cloud-ui/components/auth/authorize-content";
import { Suspense } from "react";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
