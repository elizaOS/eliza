/**
 * Cloud-route registration for the billing domain.
 *
 * Side-effect module: importing it registers the billing routes against the
 * shared {@link registerCloudRoute} registry the app shell renders. Routes are
 * lazy so the billing + wallet chunks only load when their path is visited.
 *
 * Registered routes (paths are relative to the cloud mount, matching the
 * registry convention and the server-issued absolute URLs):
 * - `dashboard/billing`          — standalone billing entry (chrome + body).
 * - `dashboard/billing/success`  — Stripe Checkout return URL
 *   (`/dashboard/billing/success?session_id=...&from=settings`).
 * - `dashboard/invoices/:id`     — invoice detail sub-view.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

const BillingSection = lazy(() => import("./BillingSection"));
const BillingSuccessPage = lazy(() => import("./BillingSuccessPage"));
const InvoiceDetailPage = lazy(() => import("./InvoiceDetailPage"));

registerCloudRoute({
  path: "dashboard/billing",
  element: BillingSection,
  group: "dashboard",
});

registerCloudRoute({
  path: "dashboard/billing/success",
  element: BillingSuccessPage,
  group: "dashboard",
});

registerCloudRoute({
  path: "dashboard/invoices/:id",
  element: InvoiceDetailPage,
  group: "dashboard",
});
