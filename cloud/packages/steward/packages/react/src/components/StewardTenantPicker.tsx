import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import type { StewardTenantMembership, StewardTenantPickerProps } from "../types.js";

/**
 * StewardTenantPicker — Switch between connected apps/tenants.
 *
 * Displays the user's tenant memberships and allows switching the active tenant.
 * Must be used inside a <StewardProvider> with `auth` configured and an SDK
 * that supports multi-tenant methods (listTenants, switchTenant).
 *
 * Two variants:
 *   - "dropdown" (default): compact trigger button, click to expand
 *   - "list": always-visible list (for settings pages)
 *
 * @example
 * <StewardTenantPicker onSwitch={(id) => console.log("switched to", id)} />
 */
export function StewardTenantPicker({
  onSwitch,
  variant = "dropdown",
  className,
}: StewardTenantPickerProps) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if tenant methods are available
  const hasTenantSupport =
    typeof auth.listTenants === "function" && typeof auth.switchTenant === "function";

  // Click-outside to close dropdown
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open && variant === "dropdown") {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, variant, handleClickOutside]);

  const handleSwitch = async (tenantId: string) => {
    if (tenantId === auth.activeTenantId) return;
    if (!hasTenantSupport) return;
    setSwitchingId(tenantId);
    try {
      const success = await auth.switchTenant(tenantId);
      if (success) {
        setOpen(false);
        onSwitch?.(tenantId);
      }
    } catch {
      // Switch failed — stay on current tenant
    } finally {
      setSwitchingId(null);
    }
  };

  // Not authenticated or no tenant support
  if (!auth.isAuthenticated || !hasTenantSupport) {
    return null;
  }

  const { tenants, activeTenantId, isTenantsLoading } = auth;

  // Find current tenant name
  const activeTenant = tenants?.find((t) => t.tenantId === activeTenantId);
  const triggerLabel = activeTenant?.tenantName ?? activeTenantId ?? "Select App";

  // Loading state
  if (isTenantsLoading && !tenants) {
    return (
      <div className={`stwd-tenant-picker stwd-tenant-picker--${variant} ${className ?? ""}`}>
        <div className="stwd-tenant-picker__loading">Loading apps…</div>
      </div>
    );
  }

  // Empty state
  if (tenants && tenants.length === 0) {
    return (
      <div className={`stwd-tenant-picker stwd-tenant-picker--${variant} ${className ?? ""}`}>
        <div className="stwd-tenant-picker__empty">No apps connected</div>
      </div>
    );
  }

  const renderItems = (items: StewardTenantMembership[]) =>
    items.map((tenant) => {
      const isActive = tenant.tenantId === activeTenantId;
      const isSwitching = tenant.tenantId === switchingId;
      return (
        <button
          key={tenant.tenantId}
          className={`stwd-tenant-picker__item ${isActive ? "stwd-tenant-picker__item--active" : ""}`}
          onClick={() => void handleSwitch(tenant.tenantId)}
          disabled={isActive || isSwitching}
          type="button"
          role="menuitem"
          aria-current={isActive ? "true" : undefined}
        >
          <span className="stwd-tenant-picker__item-name">{tenant.tenantName}</span>
          <span className="stwd-tenant-picker__item-role">
            {isSwitching ? "Switching…" : tenant.role}
          </span>
        </button>
      );
    });

  // List variant — always visible
  if (variant === "list") {
    return (
      <div className={`stwd-tenant-picker stwd-tenant-picker--list ${className ?? ""}`}>
        <div className="stwd-tenant-picker__list" role="menu">
          {tenants && renderItems(tenants)}
        </div>
      </div>
    );
  }

  // Dropdown variant
  return (
    <div
      className={`stwd-tenant-picker stwd-tenant-picker--dropdown ${className ?? ""}`}
      ref={containerRef}
    >
      <button
        className="stwd-tenant-picker__trigger"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span className="stwd-tenant-picker__trigger-label">{triggerLabel}</span>
        <span className="stwd-tenant-picker__trigger-arrow">{open ? "▲" : "▼"}</span>
      </button>

      {open && tenants && (
        <div className="stwd-tenant-picker__menu" role="menu">
          {renderItems(tenants)}
        </div>
      )}
    </div>
  );
}
