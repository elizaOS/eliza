/**
 * Account page body: profile form, organization info, account details. The
 * live MFA / privacy / delete controls live in the Security section instead.
 */

import {
  BrandCard,
  CornerBrackets,
  DashboardPageContainer,
  useSetPageHeader,
} from "../../../cloud-ui";
import type { UserProfile } from "../data/user";
import { AccountDetails } from "./account-details";
import { OrganizationInfo } from "./organization-info";
import { ProfileForm } from "./profile-form";

interface AccountPageClientProps {
  user: UserProfile;
}

export function AccountPageClient({ user }: AccountPageClientProps) {
  useSetPageHeader({
    title: "Account",
    description: "Manage your account preferences and profile information",
  });

  const displayName =
    user.name ||
    user.email ||
    (user.wallet_address
      ? `${user.wallet_address.substring(0, 6)}...${user.wallet_address.substring(user.wallet_address.length - 4)}`
      : "User");

  return (
    <DashboardPageContainer width="narrow" className="flex flex-col gap-6">
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm text-txt-strong">
              Welcome back, <span className="font-semibold">{displayName}</span>
              !
            </p>
            {user.organization?.name && (
              <p className="text-xs text-muted mt-1">
                You&apos;re part of{" "}
                <span className="font-medium">{user.organization.name}</span>
              </p>
            )}
          </div>
        </div>
      </BrandCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <ProfileForm user={user} />
        </div>

        <div className="space-y-6">
          {user.organization && (
            <OrganizationInfo organization={user.organization} />
          )}
          <AccountDetails user={user} />
        </div>
      </div>
    </DashboardPageContainer>
  );
}
