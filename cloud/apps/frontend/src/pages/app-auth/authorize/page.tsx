import { Suspense } from "react";

import { AuthorizeContent } from "@/packages/ui/src/components/auth/authorize-content";

export default function AppAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeContent />
    </Suspense>
  );
}
