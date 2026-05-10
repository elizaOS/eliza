import { AuthorizeContent } from "@elizaos/cloud-ui";
import { Suspense } from "react";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
