"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { AffiliatesPageClient } from "./affiliates-page-client";

export function AffiliatesPageWrapper() {
  useSetPageHeader({
    title: "Affiliates & Referrals",
    description: "Share your invite link and manage your affiliate markup",
  });

  return <AffiliatesPageClient />;
}
