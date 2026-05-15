import { AuthorizeContent } from "@elizaos/ui";
import { Suspense } from "react";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
