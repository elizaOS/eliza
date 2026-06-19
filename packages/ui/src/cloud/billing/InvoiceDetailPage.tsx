/**
 * /dashboard/invoices/:id — single invoice detail. Lifted from
 * `@elizaos/cloud-frontend/src/dashboard/invoices/[id]/Page.tsx` with Helmet
 * removed (the app shell owns the document head).
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import { Navigate, useParams } from "react-router-dom";
import { useCloudT } from "../shell/CloudI18nProvider";
import { InvoiceDetailClient } from "./components/invoice-detail-client";
import { ApiError, useBillingUser, useInvoice } from "./data/billing-data";

export default function InvoiceDetailPage() {
  const t = useCloudT();
  const { id } = useParams<{ id: string }>();
  const { user, isLoading: userLoading, isAuthenticated } = useBillingUser();
  const orgId = user?.organization_id ?? null;
  const invoice = useInvoice(id, orgId);
  const loadingLabel = t("cloud.invoices.loading", {
    defaultValue: "Loading invoice",
  });

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (userLoading || invoice.isLoading) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (invoice.error) {
    if (
      invoice.error instanceof ApiError &&
      (invoice.error.status === 404 || invoice.error.status === 403)
    ) {
      return <Navigate to="/settings#billing" replace />;
    }
    return <DashboardErrorState message={invoice.error.message} />;
  }

  if (!invoice.data) {
    return <Navigate to="/settings#billing" replace />;
  }

  return <InvoiceDetailClient invoice={invoice.data} />;
}
