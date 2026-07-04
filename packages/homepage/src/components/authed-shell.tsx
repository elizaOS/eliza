/**
 * Authenticated route shell that installs query and session providers around
 * nested homepage routes.
 */
import { Outlet } from "react-router-dom";
import { QueryProvider } from "@/components/providers/query-provider";
import { AuthProvider } from "@/lib/context/auth-context";

export default function AuthedShell() {
  return (
    <QueryProvider>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryProvider>
  );
}
