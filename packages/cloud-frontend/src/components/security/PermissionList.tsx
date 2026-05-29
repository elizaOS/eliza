import { Checkbox, Label } from "@elizaos/ui";
import { Info } from "lucide-react";
import { useT } from "@/providers/I18nProvider";

export interface PluginPermission {
  /** Stable identifier — e.g. `net.egress`, `fs.write`, `exec`, `vision`. */
  id: string;
  /** Human-readable name shown in the checkbox label. */
  label: string;
  /** Short tooltip describing what the permission allows. */
  description: string;
  /** Whether this permission is sensitive (default-off, requires explicit consent). */
  sensitive?: boolean;
  /** Optional scope hint, e.g. host patterns for net.egress. */
  scope?: string;
}

interface PermissionListProps {
  permissions: PluginPermission[];
  selected: ReadonlySet<string>;
  onToggle: (id: string, next: boolean) => void;
  disabled?: boolean;
}

/**
 * Renders the per-permission consent checklist for a plugin install. Sensitive
 * permissions render with a warning tint and default OFF; the caller controls
 * the `selected` set, so granting requires an explicit user click.
 */
export function PermissionList({
  permissions,
  selected,
  onToggle,
  disabled,
}: PermissionListProps) {
  const t = useT();
  if (permissions.length === 0) {
    return (
      <p className="text-xs text-white/60">
        {t("cloud.permissionList.noPermissions", {
          defaultValue: "This plugin requests no host or sandbox permissions.",
        })}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="permission-list">
      {permissions.map((perm) => {
        const isSelected = selected.has(perm.id);
        const inputId = `perm-${perm.id}`;
        const sensitive = !!perm.sensitive;
        return (
          <li
            key={perm.id}
            className={`flex items-start gap-3 rounded-sm border p-3 ${
              sensitive
                ? "border-yellow-500/40 bg-yellow-500/5"
                : "border-white/10 bg-black/40"
            }`}
          >
            <Checkbox
              id={inputId}
              checked={isSelected}
              disabled={disabled}
              onCheckedChange={(next) => onToggle(perm.id, next === true)}
              data-testid={`perm-checkbox-${perm.id}`}
            />
            <div className="flex-1 space-y-0.5">
              <Label
                htmlFor={inputId}
                className="flex items-center gap-2 text-sm font-medium text-white"
              >
                {perm.label}
                {sensitive ? (
                  <span className="rounded-sm border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-yellow-300">
                    {t("cloud.permissionList.sensitive", {
                      defaultValue: "sensitive",
                    })}
                  </span>
                ) : null}
                <Info
                  className="h-3 w-3 text-white/40"
                  aria-label={perm.description}
                />
              </Label>
              <p className="text-xs text-white/60">{perm.description}</p>
              {perm.scope ? (
                <p className="font-mono text-[11px] text-white/40">
                  {t("cloud.permissionList.scope", {
                    scope: perm.scope,
                    defaultValue: "scope: {{scope}}",
                  })}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
