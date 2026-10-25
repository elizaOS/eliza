/**
 * Read-only account details: account id and join date. Email belongs to the
 * profile editor, so this card deliberately does not repeat it.
 */

import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { UserProfile } from "../data/user";

interface AccountDetailsProps {
  user: UserProfile;
}

export function AccountDetails({ user }: AccountDetailsProps) {
  const t = useCloudT();
  const created = user.created_at
    ? new Date(user.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <SettingsStack data-testid="cloud-account-details">
      <SettingsGroup
        title={t("cloud.accountDetails.title", {
          defaultValue: "Account details",
        })}
      >
        <SettingsRow
          label={t("cloud.accountDetails.accountId", {
            defaultValue: "Account ID",
          })}
          description={
            <span className="break-all font-mono text-txt-strong">
              {user.id}
            </span>
          }
        />

        {created ? (
          <SettingsRow
            label={t("cloud.accountDetails.accountCreated", {
              defaultValue: "Member since",
            })}
            description={<span className="text-txt-strong">{created}</span>}
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
