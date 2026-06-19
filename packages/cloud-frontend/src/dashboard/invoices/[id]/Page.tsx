import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { Navigate, useParams } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";
import { ApiError } from "../../../lib/api-client";
import { useInvoice } from "../../../lib/data/invoices";
import { useUserProfile } from "../../../lib/data/user";
import { InvoiceDetailClient } from "../_components/invoice-detail-client";

/** /dashboard/invoices/:id */
export default function InvoiceDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const {
    user,
    isReady,
    isAuthenticated,
    isLoading: userLoading,
  } = useUserProfile();
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

  if (userLoading || invoice.isLoading) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (!user) {
    return <DashboardLoadingState label={loadingLabel} />;
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
        <title>
          {t("cloud.invoices.metaTitle", { defaultValue: "Invoice Details" })}
        </title>
        <meta
          name="description"
          content={t("cloud.invoices.metaDescription", {
            defaultValue: "View invoice details and transaction information",
          })}
        />
      </Helmet>
      <InvoiceDetailClient invoice={invoice.data} />
    </>
  );
}
