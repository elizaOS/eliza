/**
 * Organization settings tab — overview header + Members / Credentials / General
 * sub-tabs.
 *
 * Ported from `@elizaos/cloud-frontend`; imports retargeted to the app-hosted
 * cloud-ui bundle + local DTO contract. Pure presentational shell: it receives a
 * resolved `UserWithOrganizationDto` and renders the org overview + nested tabs.
 *
 * Deep-link intent (connect-link UX, #11332 design §5): `?tab=credentials`
 * selects the Credentials tab and `?contribute=1` opens the contribute modal —
 * the landing an invite link with `connect=1` resolves to after acceptance.
 * Read from `window.location` (not router hooks) so it works identically when
 * mounted as a settings section or as the standalone `dashboard/organization`
 * route.
 *
 * @param props - Organization tab configuration
 * @param props.user - User data with organization information
 */

import { KeyRound, Settings, Users } from "lucide-react";
import { useState } from "react";
import {
  BrandCard,
  BrandTabs,
  BrandTabsContent,
  BrandTabsList,
  BrandTabsTrigger,
  CornerBrackets,
} from "../../cloud-ui";
import { CredentialsTab } from "./credentials-tab";
import type { UserWithOrganizationDto } from "./data/cloud-org-types";
import { MembersTab } from "./members-tab";
import { OrganizationGeneralTab } from "./organization-general-tab";

interface OrganizationTabProps {
  user: UserWithOrganizationDto;
}

const ORG_TABS = ["members", "credentials", "general"] as const;

/** `?tab=` + `?contribute=1` deep-link intent (connect-link landing). */
export function readOrganizationTabIntent(): {
  tab: (typeof ORG_TABS)[number];
  contribute: boolean;
} {
  if (typeof window === "undefined") {
    return { tab: "members", contribute: false };
  }
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tab");
  const tab = ORG_TABS.find((value) => value === requested) ?? "members";
  return { tab, contribute: params.get("contribute") === "1" };
}

export function OrganizationTab({ user }: OrganizationTabProps) {
  const [intent] = useState(readOrganizationTabIntent);
  const [activeTab, setActiveTab] = useState<string>(intent.tab);

  if (!user.organization) {
    return (
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 text-center py-12">
          <p className="text-white/60">No organization found</p>
        </div>
      </BrandCard>
    );
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Organization Overview Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 flex flex-col sm:flex-row items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
              <h2 className="text-base md:text-xl font-mono font-semibold text-[#e1e1e1] uppercase">
                {user.organization.name}
              </h2>
            </div>
            <p className="text-xs md:text-sm font-mono text-white/60">
              {user.organization.slug}
            </p>
          </div>
          <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface px-4 py-3">
            <div className="text-left sm:text-right">
              <p className="text-xl md:text-2xl font-mono font-bold text-white">
                ${Number(user.organization.credit_balance).toFixed(2)}
              </p>
              <p className="text-xs font-mono text-white/50 uppercase tracking-wide">
                Credits Available
              </p>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Tabs */}
      <BrandTabs
        id="organization-tabs"
        value={activeTab}
        onValueChange={setActiveTab}
        className="w-full"
      >
        <BrandTabsList className="w-full max-w-xl">
          <BrandTabsTrigger
            value="members"
            className="flex items-center gap-2 flex-1"
          >
            <Users className="h-3 md:h-4 w-3 md:w-4" />
            <span className="text-xs md:text-sm">Members</span>
          </BrandTabsTrigger>
          <BrandTabsTrigger
            value="credentials"
            className="flex items-center gap-2 flex-1"
          >
            <KeyRound className="h-3 md:h-4 w-3 md:w-4" />
            <span className="text-xs md:text-sm">Credentials</span>
          </BrandTabsTrigger>
          <BrandTabsTrigger
            value="general"
            className="flex items-center gap-2 flex-1"
          >
            <Settings className="h-3 md:h-4 w-3 md:w-4" />
            <span className="text-xs md:text-sm">General</span>
          </BrandTabsTrigger>
        </BrandTabsList>

        <BrandTabsContent value="members" className="mt-4 md:mt-6">
          <MembersTab user={user} />
        </BrandTabsContent>

        <BrandTabsContent value="credentials" className="mt-4 md:mt-6">
          <CredentialsTab
            user={user}
            autoContribute={intent.tab === "credentials" && intent.contribute}
          />
        </BrandTabsContent>

        <BrandTabsContent value="general" className="mt-4 md:mt-6">
          <OrganizationGeneralTab organization={user.organization} />
        </BrandTabsContent>
      </BrandTabs>
    </div>
  );
}
