/**
 * Account page body: the profile form + a read-only account-details card. Live
 * MFA / privacy / delete controls live in the Security section instead. The
 * console presents plain per-user accounts, so no org/welcome cards here.
 */

import { DashboardPageContainer, useSetPageHeader } from "../../../cloud-ui";
import type { UserProfile } from "../data/user";
import { AccountDetails } from "./account-details";
import { ProfileForm } from "./profile-form";

interface AccountPageClientProps {
  user: UserProfile;
}

export function AccountPageClient({ user }: AccountPageClientProps) {
  useSetPageHeader({
    title: "Account",
    description: "Profile and account details",
  });

  return (
    <DashboardPageContainer
      width="narrow"
      className="grid grid-cols-1 gap-6 lg:grid-cols-2"
    >
      <ProfileForm user={user} />
      <AccountDetails user={user} />
    </DashboardPageContainer>
  );
}
