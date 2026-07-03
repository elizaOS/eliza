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
import { Button } from "../../components/ui/button";
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

function healthDotClass(health: string): string {
  switch (health) {
    case "ok":
      return "bg-green-500";
    case "rate-limited":
      return "bg-[#FF5800]";
    default:
      // needs-reauth / invalid / unknown
      return "bg-[#EB4335]";
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
      <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface p-8 text-center">
        <KeyRound className="h-12 w-12 mx-auto text-white/40 mb-4" />
        <p className="text-sm font-mono text-white/60">
          {t("cloud.credentialsList.empty", {
            defaultValue:
              "No pooled credentials yet. Contribute a provider API key to get started.",
          })}
        </p>
      </div>
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
          <div
            key={credential.id}
            className={`bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 ${credential.enabled ? "" : "opacity-60"}`}
          >
            <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
              <div className="flex-1 min-w-0 w-full space-y-2">
                {/* Label + provider badge */}
                <div className="flex items-center gap-2 flex-wrap">
                  <KeyRound className="h-4 w-4 text-white/40 flex-shrink-0" />
                  <span className="font-mono font-semibold text-sm md:text-base text-white truncate">
                    {credential.label}
                  </span>
                  <span className="px-2 py-0.5 border border-[#FF5800]/40 bg-[#FF5800]/10 text-[#FF5800] text-xs font-mono uppercase">
                    {providerDisplayName(credential.provider)}
                  </span>
                </div>

                {/* Masked key + health */}
                <div className="flex items-center gap-3 flex-wrap text-xs md:text-sm font-mono text-white/60">
                  <span title={`key ending in ${credential.last4}`}>
                    ••••{credential.last4}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      data-testid={`health-dot-${credential.id}`}
                      data-health={credential.health}
                      className={`inline-block w-2 h-2 rounded-full ${credential.enabled ? healthDotClass(credential.health) : "bg-white/30"}`}
                    />
                    <span className="capitalize">
                      {healthLabel(credential)}
                    </span>
                  </span>
                </div>
                {credential.healthDetail?.lastError && (
                  <p className="text-xs font-mono text-[#EB4335] break-all">
                    {credential.healthDetail.lastError}
                  </p>
                )}

                {/* Usage + contributor */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs font-mono text-white/40">
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
                        <User className="h-3 w-3" />
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
                        variant="ghost"
                        type="button"
                        aria-label={t("cloud.credentialsList.removeLabel", {
                          label: credential.label,
                          defaultValue: "Remove {{label}}",
                        })}
                        className="p-2 hover:bg-white/5 transition-colors border border-white/10"
                      >
                        <Trash2 className="h-4 w-4 text-[#EB4335]" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="bg-neutral-950 border border-brand-surface">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white font-mono">
                          {t("cloud.credentialsList.removeTitle", {
                            defaultValue: "Remove Credential",
                          })}
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-white/60 font-mono text-sm">
                          {t("cloud.credentialsList.removeConfirm", {
                            label: credential.label,
                            defaultValue:
                              "Remove {{label}} from the pool? The org stops rotating onto this key immediately. The key itself is deleted from the vault and cannot be recovered.",
                          })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="bg-transparent border-[#303030] text-white hover:bg-white/5">
                          {t("cloud.credentialsList.cancel", {
                            defaultValue: "Cancel",
                          })}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => onRemove(credential.id)}
                          className="bg-[#EB4335] hover:bg-[#EB4335]/90 text-white"
                        >
                          {t("cloud.credentialsList.remove", {
                            defaultValue: "Remove",
                          })}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
