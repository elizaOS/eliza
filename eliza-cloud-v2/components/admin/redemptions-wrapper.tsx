"use client";

import { useSetPageHeader } from "@/components/layout/page-header-context";
import { AdminRedemptionsClient } from "./redemptions-client";

export function AdminRedemptionsWrapper() {
  useSetPageHeader({
    title: "Redemption Management",
    description: "Review and approve token redemption requests",
  });

  return <AdminRedemptionsClient />;
}
