/**
 * Account page body: profile, account details, and server-authoritative privacy
 * controls. The console presents plain per-user accounts.
 */

import { DashboardPageContainer } from "../../../cloud-ui/components/layout/dashboard-page";
import type { UserProfile } from "../data/user";
import { AccountDetails } from "./account-details";
import { PrivacyPanel } from "./privacy-panel";
import { ProfileForm } from "./profile-form";

interface AccountPageClientProps {
  user: UserProfile;
}

export function AccountPageClient({ user }: AccountPageClientProps) {
  return (
    <DashboardPageContainer
      width="narrow"
      className="grid grid-cols-1 gap-6 lg:grid-cols-2"
    >
      <ProfileForm user={user} />
      <AccountDetails user={user} />
      <div className="lg:col-span-2">
        <PrivacyPanel />
      </div>
    </DashboardPageContainer>
  );
}
