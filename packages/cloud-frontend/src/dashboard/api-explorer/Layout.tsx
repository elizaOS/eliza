import { Outlet } from "react-router-dom";

/**
 * /dashboard/api-explorer layout. The legacy Next.js layout was a metadata-
 * only pass-through; the SPA equivalent is a bare `<Outlet />`. Page-level
 * `<Helmet>` owns the title now.
 */
export default function ApiExplorerLayout() {
  return <Outlet />;
}
