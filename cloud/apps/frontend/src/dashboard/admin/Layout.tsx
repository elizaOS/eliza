import { Ban, Loader2, Shield } from "lucide-react";
import { Navigate, Outlet } from "react-router-dom";
import { useAdminModerationStatus } from "../../lib/data/admin";
import { useUserProfile } from "../../lib/data/user";

/**
 * /dashboard/admin — admin role gate. The parent dashboard layout already
 * enforces auth; this layout enforces the admin-or-better moderation role.
 */
export default function AdminLayout() {
  const { isReady, isAuthenticated } = useUserProfile();
  const { data, isLoading, isError } = useAdminModerationStatus();

  if (!isReady || (isAuthenticated && isLoading)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login?returnTo=%2Fdashboard%2Fadmin" replace />;
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Shield className="h-16 w-16 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Admin status unavailable</h1>
        <p className="text-muted-foreground">Could not verify admin role.</p>
      </div>
    );
  }

  if (!data?.isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Ban className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You don&apos;t have admin privileges.</p>
      </div>
    );
  }

  return <Outlet />;
}
