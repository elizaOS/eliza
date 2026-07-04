/**
 * Public-pages domain barrel.
 *
 * The app shell imports {@link registerPublicPages}
 * to mount all token-gated / auth / marketing / payment routes onto the shared
 * cloud-route registry (the `CloudRouterShell` renders whatever the registry
 * returns). Importing the module for its side effect is enough:
 *
 *   import { registerPublicPages } from "@elizaos/ui/cloud/public-pages";
 *   registerPublicPages();
 *
 * The page components + the domain's lib helpers are also re-exported for hosts
 * that want to mount a page directly (e.g. tests) rather than via the registry.
 *
 * StewardLoginSection is deliberately NOT re-exported: it imports the
 * wagmi/RainbowKit/Solana wallet stack, and a static re-export here would drag
 * that multi-MB graph into every chunk that loads this barrel (register-all →
 * the cloud router shell). LoginPage already code-splits it behind React.lazy
 * with a designed fallback — import it from
 * "./pages/login/steward-login-section" directly if a host ever needs it.
 */

export { useMetaTag, usePageTitle } from "./lib/use-page-title";
export { default as AppAuthAuthorizePage } from "./pages/app-auth/app-authorize-page";
export { default as ApprovalPage } from "./pages/approve/approval-page";
export { default as AuthErrorPage } from "./pages/auth/auth-error-page";
export { default as AuthSuccessPage } from "./pages/auth/auth-success-page";
export { default as CliLoginPage } from "./pages/auth/cli-login-page";
export { default as EmailCallbackPage } from "./pages/auth/email-callback-page";
export { default as BallotPage } from "./pages/ballot/ballot-page";
export { default as BscPromoPage } from "./pages/bsc-page";
export { default as PublicChatPage } from "./pages/chat/public-chat-page";
export { default as InviteAcceptPage } from "./pages/invite/invite-accept-page";
export { default as PrivacyPolicyPage } from "./pages/legal/privacy-policy-page";
export { default as TermsOfServicePage } from "./pages/legal/terms-of-service-page";
export { default as LoginPage } from "./pages/login/login-page";
export { default as AppChargePaymentPage } from "./pages/payment/app-charge-page";
export { default as PaymentRequestPage } from "./pages/payment/payment-request-page";
export { default as PaymentSuccessPage } from "./pages/payment/payment-success-page";
export { default as SensitiveRequestPage } from "./pages/sensitive-requests/sensitive-request-page";
export { registerPublicPages } from "./register";
