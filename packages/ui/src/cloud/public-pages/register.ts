/**
 * Cloud-route registration for the public-pages domain.
 *
 * Registers every token-gated / auth / marketing / payment route this domain
 * owns against the shell's cloud-route registry. All are `public: true` — they
 * render WITHOUT the app-shell chrome and WITHOUT the Steward auth wrapper at
 * the route level (the pages that need a session read it via `useSessionAuth`,
 * which falls back to localStorage). Paths mirror the backend-issued deep-link
 * contract verbatim: payment / approve / ballot /
 * sensitive-requests / chat / invite / login / auth / app-auth / legal / bsc.
 *
 * Importing this module is the single side-effecting entry point: the app shell
 * imports it once at boot, after which `listCloudRoutes()` returns these routes.
 */

import { lazy } from "react";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

const PaymentRequestPage = lazy(
  () => import("./pages/payment/payment-request-page"),
);
const PaymentSuccessPage = lazy(
  () => import("./pages/payment/payment-success-page"),
);
const AppChargePaymentPage = lazy(
  () => import("./pages/payment/app-charge-page"),
);
const ApprovalPage = lazy(() => import("./pages/approve/approval-page"));
const BallotPage = lazy(() => import("./pages/ballot/ballot-page"));
const SensitiveRequestPage = lazy(
  () => import("./pages/sensitive-requests/sensitive-request-page"),
);
const PublicChatPage = lazy(() => import("./pages/chat/public-chat-page"));
const InviteAcceptPage = lazy(
  () => import("./pages/invite/invite-accept-page"),
);
const LoginPage = lazy(() => import("./pages/login/login-page"));
const AuthSuccessPage = lazy(() => import("./pages/auth/auth-success-page"));
const AuthErrorPage = lazy(() => import("./pages/auth/auth-error-page"));
const CliLoginPage = lazy(() => import("./pages/auth/cli-login-page"));
const EmailCallbackPage = lazy(
  () => import("./pages/auth/email-callback-page"),
);
const AppAuthAuthorizePage = lazy(
  () => import("./pages/app-auth/app-authorize-page"),
);
const TermsOfServicePage = lazy(
  () => import("./pages/legal/terms-of-service-page"),
);
const PrivacyPolicyPage = lazy(
  () => import("./pages/legal/privacy-policy-page"),
);
const BscPromoPage = lazy(() => import("./pages/bsc-page"));

let registered = false;
const PUBLIC_ROUTE_ACCESS = {
  public: true,
  publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
} as const;

/**
 * Register all public-pages routes. Idempotent — safe to call more than once
 * (later registration of the same path is a no-op replace in the registry).
 */
export function registerPublicPages(): void {
  if (registered) return;
  registered = true;

  // ── Payment (external/unauthenticated payers; the id IS the link) ──
  registerCloudRoute({
    path: "payment/:paymentRequestId",
    element: PaymentRequestPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "payment",
  });
  registerCloudRoute({
    path: "payment/success",
    element: PaymentSuccessPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "payment",
  });
  registerCloudRoute({
    path: "payment/app-charge/:appId/:chargeId",
    element: AppChargePaymentPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "payment",
  });

  // ── Token-gated action pages ──
  registerCloudRoute({
    path: "approve/:approvalId",
    element: ApprovalPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "token",
  });
  registerCloudRoute({
    path: "ballot/:ballotId",
    element: BallotPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "token",
  });
  registerCloudRoute({
    path: "sensitive-requests/:requestId",
    element: SensitiveRequestPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "token",
  });

  // ── Public shared chat (no-login funnel) ──
  registerCloudRoute({
    path: "chat/:characterRef",
    element: PublicChatPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "public",
  });

  // ── Org invite ──
  registerCloudRoute({
    path: "invite/accept",
    element: InviteAcceptPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  // Legacy alias kept by the backend deep-link contract.
  registerCloudRoute({
    path: "accept-invitation",
    element: InviteAcceptPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });

  // ── Login + Steward auth surfaces ──
  registerCloudRoute({
    path: "login",
    element: LoginPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  registerCloudRoute({
    path: "auth/success",
    element: AuthSuccessPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  registerCloudRoute({
    path: "auth/error",
    element: AuthErrorPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  registerCloudRoute({
    path: "auth/cli-login",
    element: CliLoginPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  registerCloudRoute({
    path: "auth/callback/email",
    element: EmailCallbackPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });
  registerCloudRoute({
    path: "app-auth/authorize",
    element: AppAuthAuthorizePage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "auth",
  });

  // ── Static legal + promo ──
  registerCloudRoute({
    path: "terms-of-service",
    element: TermsOfServicePage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "legal",
  });
  registerCloudRoute({
    path: "privacy-policy",
    element: PrivacyPolicyPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "legal",
  });
  registerCloudRoute({
    path: "bsc",
    element: BscPromoPage,
    ...PUBLIC_ROUTE_ACCESS,
    group: "public",
  });
}
