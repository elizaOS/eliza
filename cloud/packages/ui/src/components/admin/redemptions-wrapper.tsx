"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { AdminRedemptionsClient } from "./redemptions-client";

export function AdminRedemptionsWrapper() {
  useSetPageHeader({
    title: "Redemption Management",
    description: "Review and approve token redemption requests",
  });

  return <AdminRedemptionsClient />;
}
