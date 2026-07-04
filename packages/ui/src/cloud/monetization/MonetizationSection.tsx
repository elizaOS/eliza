/**
 * Merged Monetization surface: Earnings (redemptions) + Affiliates (referrals)
 * as two tabs. This is the single monetization home, registered as the
 * `cloud-monetization` settings section.
 *
 * The settings-section registry renders a zero-prop `Component`; the settings
 * view is mounted inside the cloud settings shell, which supplies the
 * React-Query client, {@link CloudI18nProvider}, and the Steward auth context
 * the surfaces read.
 */

import { useState } from "react";
// Canonical primitive import per the packages/ui extension rules (cloud code
// imports components/ui/* directly, not re-export shims).
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AffiliatesSurface } from "./affiliates/AffiliatesSurface";
import { EarningsSurface } from "./earnings/EarningsSurface";

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
