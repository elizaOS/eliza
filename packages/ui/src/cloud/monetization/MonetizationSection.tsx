/**
 * Merged Monetization surface: Earnings (redemptions) + Affiliates (referrals)
 * as two tabs.
 *
 * PLAN §3 maps both `dashboard/earnings` and `dashboard/affiliates` to a single
 * **Monetization** settings section ("Real on-chain payout + referral. Merge
 * affiliates into earnings."). This component is the merged home; each tab reuses
 * the exact bare surface the standalone routes render, so the section and the
 * standalone deep links stay identical.
 *
 * The settings-section registry renders a zero-prop `Component`; the settings
 * view itself is mounted inside the cloud shell, which supplies the React-Query
 * client, {@link CloudI18nProvider}, and the Steward auth context the surfaces
 * read.
 */

import { useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../cloud-ui/components/primitives";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AffiliatesSurface } from "./affiliates/AffiliatesRoute";
import { EarningsSurface } from "./earnings/EarningsRoute";

export function MonetizationView() {
  const t = useCloudT();
  const [tab, setTab] = useState<"earnings" | "affiliates">("earnings");

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as "earnings" | "affiliates")}
      className="flex flex-col gap-6"
    >
      <TabsList className="grid w-full max-w-md grid-cols-2">
        <TabsTrigger value="earnings">
          {t("cloud.monetization.tabEarnings", {
            defaultValue: "Earnings",
          })}
        </TabsTrigger>
        <TabsTrigger value="affiliates">
          {t("cloud.monetization.tabAffiliates", {
            defaultValue: "Affiliates",
          })}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="earnings">
        <EarningsSurface />
      </TabsContent>
      <TabsContent value="affiliates">
        <AffiliatesSurface />
      </TabsContent>
    </Tabs>
  );
}

/** Zero-prop component for `registerSettingsSection({ Component })`. */
export function MonetizationSection() {
  return <MonetizationView />;
}
