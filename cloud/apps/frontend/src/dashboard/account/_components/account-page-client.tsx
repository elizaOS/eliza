/**
 * Account page client component organizing account management sections.
 * Displays profile form, organization info, account details, and security preferences.
 *
 * @param props - Account page client configuration
 * @param props.user - User data with organization information
 */

"use client";

import {
  BrandCard,
  CornerBrackets,
  DashboardPageContainer,
  useSetPageHeader,
} from "@elizaos/cloud-ui";
import type { UserWithOrganizationDto } from "@/types/cloud-api";
import { AccountDetails } from "./account-details";
import { OrganizationInfo } from "./organization-info";
import { ProfileForm } from "./profile-form";
import { SecurityPreferences } from "./security-preferences";

interface AccountPageClientProps {
  user: UserWithOrganizationDto;
}

export function AccountPageClient({ user }: AccountPageClientProps) {
  useSetPageHeader({
    title: "Account",
    description: "Manage your account preferences and profile information",
  });

  return (
    <DashboardPageContainer width="narrow" className="flex flex-col gap-6">
      {/* Welcome Message */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm text-white">
              Welcome back,{" "}
              <span className="font-semibold">
                {user.name ||
                  user.email ||
                  (user.wallet_address
                    ? `${user.wallet_address.substring(0, 6)}...${user.wallet_address.substring(user.wallet_address.length - 4)}`
                    : "User")}
              </span>
              !
            </p>
            <p className="text-xs text-white/60 mt-1">
              You&apos;re part of <span className="font-medium">{user.organization?.name}</span>{" "}
              organization
            </p>
          </div>
        </div>
      </BrandCard>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column - Profile Form */}
        <div className="space-y-6">
          <ProfileForm user={user} />
        </div>

        {/* Right Column - Additional Info */}
        <div className="space-y-6">
          {user.organization && <OrganizationInfo organization={user.organization} />}
          <AccountDetails user={user} />
        </div>
      </div>

      {/* Full Width - Security Preferences */}
      <div className="w-full">
        <SecurityPreferences />
      </div>
    </DashboardPageContainer>
  );
}
