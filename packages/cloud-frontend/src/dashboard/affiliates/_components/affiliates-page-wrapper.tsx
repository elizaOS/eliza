"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import { AffiliatesPageClient } from "./affiliates-page-client";

export function AffiliatesPageWrapper() {
  return (
    <DashboardRoutePage
      title="Affiliates & Referrals"
      description="Share your invite link and manage your affiliate markup"
    >
      <AffiliatesPageClient />
    </DashboardRoutePage>
  );
}
