import {
  BrandButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@elizaos/ui";
import { useMemo, useState } from "react";
import { useT } from "@/providers/I18nProvider";
import { PermissionList, type PluginPermission } from "./PermissionList";
import { TrustBadge, type TrustBadgeVariant } from "./TrustBadge";

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginName: string;
  pluginVersion?: string;
  publisher?: string;
  trust: TrustBadgeVariant;
  permissions: PluginPermission[];
  /** Pre-checked perms; sensitive perms should NOT be pre-checked. */
  initialSelected?: ReadonlyArray<string>;
  onConfirm: (granted: ReadonlyArray<string>) => void | Promise<void>;
  onCancel?: () => void;
  busy?: boolean;
}

/**
 * The user-facing install consent dialog. Two hard rules:
 *
 *  1. If `trust === "unsigned"` the install button is permanently disabled —
 *     there is no UI override (the server should refuse anyway, but we mirror
 *     the policy in the UI so the user never sees a misleading "try again").
 *  2. Sensitive permissions default to OFF. The parent passes `initialSelected`
 *     for any non-sensitive perms it wants pre-checked; everything else must
 *     be opted into explicitly.
 */
export function ConsentDialog({
  open,
  onOpenChange,
  pluginName,
  pluginVersion,
  publisher,
  trust,
  permissions,
  initialSelected,
  onConfirm,
  onCancel,
  busy,
}: ConsentDialogProps) {
  const t = useT();
  const initial = useMemo<ReadonlySet<string>>(() => {
    if (!initialSelected) return new Set();
    return new Set(
      initialSelected.filter((id) => {
        const perm = permissions.find((p) => p.id === id);
        // Sensitive perms can never be pre-selected from outside.
        return perm && !perm.sensitive;
      }),
    );
  }, [initialSelected, permissions]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));

  const toggle = (id: string, next: boolean) => {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });
  };

  const installBlocked = trust === "unsigned";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && onCancel) onCancel();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="consent-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("cloud.consentDialog.install", {
              pluginName,
              defaultValue: "Install {{pluginName}}",
            })}
            {pluginVersion ? (
              <span className="text-xs font-normal text-white/50">
                v{pluginVersion}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {t("cloud.consentDialog.description", {
              defaultValue:
                "Review the permissions this plugin is requesting. Sensitive permissions are off by default — grant only what you trust.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <TrustBadge variant={trust} publisher={publisher} />
            {publisher ? (
              <span className="text-xs text-white/50">
                {t("cloud.consentDialog.by", {
                  publisher,
                  defaultValue: "by {{publisher}}",
                })}
              </span>
            ) : null}
          </div>

          {installBlocked ? (
            <p
              className="rounded-sm border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
              data-testid="consent-dialog-blocked"
            >
              {t("cloud.consentDialog.blocked", {
                defaultValue:
                  "The publisher signature did not verify. Eliza will refuse to install this plugin. There is no override.",
              })}
            </p>
          ) : null}

          <PermissionList
            permissions={permissions}
            selected={selected}
            onToggle={toggle}
            disabled={installBlocked || busy}
          />
        </div>

        <DialogFooter>
          <BrandButton
            variant="ghost"
            onClick={() => {
              if (onCancel) onCancel();
              onOpenChange(false);
            }}
            disabled={busy}
          >
            {t("cloud.consentDialog.cancel", { defaultValue: "Cancel" })}
          </BrandButton>
          <BrandButton
            variant="primary"
            disabled={installBlocked || busy}
            onClick={async () => {
              await onConfirm(Array.from(selected));
            }}
            data-testid="consent-dialog-confirm"
          >
            {busy
              ? t("cloud.consentDialog.installing", {
                  defaultValue: "Installing…",
                })
              : t("cloud.consentDialog.installWithPermissions", {
                  defaultValue: "Install with selected permissions",
                })}
          </BrandButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
