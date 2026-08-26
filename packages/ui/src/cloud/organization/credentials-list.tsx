/**
 * Pooled-credentials list for the org Credentials tab (#11332).
 *
 * Per-row: label, provider badge, masked key (…last4), health dot (+ rate-limit
 * `until` / probe error from healthDetail), today's calls, contributor, enable
 * toggle, delete. Everything rendered here is the MASKED summary — the backend
 * never returns key material on reads.
 *
 * RBAC (mirrors the route gates):
 * - enable toggle → owner/admin only
 * - delete        → owner/admin, or the contributor removing their own key
 *
 * @param props.credentials - Masked pooled credentials
 * @param props.currentUserId - Current user's id (own-contribution delete)
 * @param props.canManage - Owner/admin (toggle + delete-any)
 * @param props.onToggle - Enable/disable callback (PATCH)
 * @param props.onRemove - Delete callback (DELETE)
 */

import { formatDistanceToNow } from "date-fns";
import { KeyRound, Trash2, User } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Switch,
} from "../../cloud-ui";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  POOLED_PROVIDER_LABELS,
  type PooledCredentialDto,
  type PooledProviderId,
} from "./data/cloud-org-types";

interface CredentialsListProps {
  credentials: PooledCredentialDto[];
  currentUserId: string;
  canManage: boolean;
  onToggle: (credentialId: string, enabled: boolean) => void;
  onRemove: (credentialId: string) => void;
}

export function providerDisplayName(provider: string): string {
  return POOLED_PROVIDER_LABELS[provider as PooledProviderId] ?? provider;
}

function healthDotVariant(health: string): NonNullable<BadgeProps["variant"]> {
  switch (health) {
    case "ok":
      return "statusDotSuccess";
    case "rate-limited":
      return "statusDotWarning";
    default:
      // needs-reauth / invalid / unknown
      return "statusDotDanger";
  }
}

/** `until` is epoch ms (LinkedAccountHealthDetail). */
function formatUntil(until: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(until));
}

export function CredentialsList({
  credentials,
  currentUserId,
  canManage,
  onToggle,
  onRemove,
}: CredentialsListProps) {
  const t = useCloudT();

  if (credentials.length === 0) {
    return (
      <Card variant="insetPadded" className="p-8 text-center">
        <KeyRound className="size-12 mx-auto text-muted mb-4" />
        <p className="text-sm font-mono text-muted">
          {t("cloud.credentialsList.empty", {
            defaultValue:
              "No pooled credentials yet. Contribute a provider API key to get started.",
          })}
        </p>
      </Card>
    );
  }

  const healthLabel = (credential: PooledCredentialDto) => {
    if (!credential.enabled) {
      return t("cloud.credentialsList.disabled", { defaultValue: "Disabled" });
    }
    if (
      credential.health === "rate-limited" &&
      credential.healthDetail?.until
    ) {
      return t("cloud.credentialsList.rateLimitedUntil", {
        until: formatUntil(credential.healthDetail.until),
        defaultValue: "Rate-limited until {{until}}",
      });
    }
    return credential.health;
  };

  return (
    <div className="space-y-3">
      {credentials.map((credential) => {
        const canDelete =
          canManage || credential.contributedBy?.id === currentUserId;

        return (
          <Card
            key={credential.id}
            variant="insetPadded"
            className={`md:p-4 ${credential.enabled ? "" : "opacity-60"}`}
          >
            <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
              <div className="flex-1 min-w-0 w-full space-y-2">
                {/* Label + provider badge */}
                <div className="flex items-center gap-2 flex-wrap">
                  <KeyRound className="size-4 text-muted shrink-0" />
                  <span className="font-mono font-semibold text-sm md:text-base text-txt-strong truncate">
                    {credential.label}
                  </span>
                  <Badge
                    variant="metaStrong"
                    size="compact"
                    className="font-mono"
                  >
                    {providerDisplayName(credential.provider)}
                  </Badge>
                </div>

                {/* Masked key + health */}
                <div className="flex items-center gap-3 flex-wrap text-xs md:text-sm font-mono text-muted">
                  <span title={`key ending in ${credential.last4}`}>
                    ••••{credential.last4}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Badge
                      variant={
                        credential.enabled
                          ? healthDotVariant(credential.health)
                          : "statusDotMuted"
                      }
                      data-testid={`health-dot-${credential.id}`}
                      data-health={credential.health}
                    />
                    <span className="capitalize">
                      {healthLabel(credential)}
                    </span>
                  </span>
                </div>
                {credential.healthDetail?.lastError && (
                  <p className="text-xs font-mono text-danger break-all">
                    {credential.healthDetail.lastError}
                  </p>
                )}

                {/* Usage + contributor */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs font-mono text-muted">
                  <span>
                    {t("cloud.credentialsList.callsToday", {
                      count: credential.callsToday,
                      defaultValue: "{{count}} calls today",
                    })}
                  </span>
                  {credential.contributedBy && (
                    <>
                      <span className="hidden sm:inline">•</span>
                      <span className="flex items-center gap-1">
                        <User className="size-3" />
                        {credential.contributedBy.name ||
                          t("cloud.credentialsList.unknownContributor", {
                            defaultValue: "Unknown",
                          })}
                        {credential.contributedBy.id === currentUserId &&
                          ` (${t("cloud.credentialsList.you", { defaultValue: "you" })})`}
                      </span>
                    </>
                  )}
                  {credential.lastUsedAt && (
                    <>
                      <span className="hidden sm:inline">•</span>
                      <span>
                        {t("cloud.credentialsList.lastUsed", {
                          when: formatDistanceToNow(
                            new Date(credential.lastUsedAt),
                            { addSuffix: true },
                          ),
                          defaultValue: "Last used {{when}}",
                        })}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
                {canManage && (
                  <Switch
                    checked={credential.enabled}
                    onCheckedChange={(enabled) =>
                      onToggle(credential.id, enabled)
                    }
                    aria-label={t("cloud.credentialsList.toggleLabel", {
                      label: credential.label,
                      defaultValue: "Toggle {{label}}",
                    })}
                  />
                )}
                {canDelete && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="dangerGhost"
                        size="icon-sm"
                        type="button"
                        aria-label={t("cloud.credentialsList.removeLabel", {
                          label: credential.label,
                          defaultValue: "Remove {{label}}",
                        })}
                      >
                        <Trash2 className="size-4 text-danger" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-txt-strong font-mono">
                          {t("cloud.credentialsList.removeTitle", {
                            defaultValue: "Remove Credential",
                          })}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-muted font-mono text-sm">
                          {t("cloud.credentialsList.removeConfirm", {
                            label: credential.label,
                            defaultValue:
                              "Remove {{label}} from the pool? The org stops rotating onto this key immediately. The key itself is deleted from the vault and cannot be recovered.",
                          })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("cloud.credentialsList.cancel", {
                            defaultValue: "Cancel",
                          })}
                        </AlertDialogCancel>
                        <Button asChild variant="destructive">
                          <AlertDialogAction
                            onClick={() => onRemove(credential.id)}
                          >
                            {t("cloud.credentialsList.remove", {
                              defaultValue: "Remove",
                            })}
                          </AlertDialogAction>
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
