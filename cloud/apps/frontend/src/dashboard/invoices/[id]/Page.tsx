import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { Navigate, useParams } from "react-router-dom";
import { ApiError } from "../../../lib/api-client";
import { useInvoice } from "../../../lib/data/invoices";
import { useUserProfile } from "../../../lib/data/user";
import { InvoiceDetailClient } from "../_components/invoice-detail-client";

/** /dashboard/invoices/:id */
export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, isReady, isAuthenticated, isLoading: userLoading } = useUserProfile();
  const orgId = user?.organization_id ?? null;
  const invoice = useInvoice(id, orgId);

  if (!isReady) {
    return <DashboardLoadingState label="Loading invoice" />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (userLoading || invoice.isLoading) {
    return <DashboardLoadingState label="Loading invoice" />;
  }

  if (!user) {
    return <DashboardLoadingState label="Loading invoice" />;
  }

  if (invoice.error) {
    if (
      invoice.error instanceof ApiError &&
      (invoice.error.status === 404 || invoice.error.status === 403)
    ) {
      return <Navigate to="/dashboard/settings?tab=billing" replace />;
    }
    return <DashboardErrorState message={invoice.error.message} />;
  }

  if (!invoice.data) {
    return <Navigate to="/dashboard/settings?tab=billing" replace />;
  }

  return (
    <>
      <Helmet>
        <title>Invoice Details</title>
        <meta name="description" content="View invoice details and transaction information" />
      </Helmet>
      <InvoiceDetailClient invoice={invoice.data} />
    </>
  );
}
