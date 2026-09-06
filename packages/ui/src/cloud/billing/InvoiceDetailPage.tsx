/**
 * /cloud/invoices/:id — single invoice detail.
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
  const {
    user,
    isPending: userPending,
    isFetching: userFetching,
    isPaused: userPaused,
    isFetchedAfterMount: userFetchedAfterMount,
    isError: userError,
    error: billingUserError,
    isReady,
    isAuthenticated,
  } = useBillingUser({ requireFreshOrganization: true });
  const orgId = user?.organization_id ?? null;
  const invoice = useInvoice(id, orgId);
  const loadingLabel = t("cloud.invoices.loading", {
    defaultValue: "Loading invoice",
  });

  if (!isReady) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (userPending) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (userError) {
    return (
      <DashboardErrorState
        message={
          billingUserError instanceof Error
            ? billingUserError.message
            : t("cloud.billing.loadError", {
                defaultValue: "Failed to load billing",
              })
        }
      />
    );
  }

  if (userFetching || userPaused || !userFetchedAfterMount) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (!user || !id) {
    return <Navigate to="/settings#cloud-billing" replace />;
  }

  if (
    invoice.isPending ||
    invoice.isFetching ||
    invoice.isPaused ||
    !invoice.isFetchedAfterMount
  ) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (invoice.error) {
    if (
      invoice.error instanceof ApiError &&
      (invoice.error.status === 404 || invoice.error.status === 403)
    ) {
      return <Navigate to="/settings#cloud-billing" replace />;
    }
    return <DashboardErrorState message={invoice.error.message} />;
  }

  if (!invoice.data) {
    return <Navigate to="/settings#cloud-billing" replace />;
  }

  return <InvoiceDetailClient invoice={invoice.data} />;
}
