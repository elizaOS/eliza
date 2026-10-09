import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { LoginBackground } from "./login-page";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

export default function NetworkSignInPage(): React.JSX.Element {
  useDocumentTitle("Sign in to The Network");

  return (
    <LoginBackground plain>
      <main className="space-y-8">
        <div className="space-y-3">
          <h1 className="font-sans text-3xl font-semibold tracking-tight text-txt-strong">
            Sign in to The Network
          </h1>
          <p className="text-base leading-relaxed text-muted">
            Use the same number you text Eliza from.
          </p>
        </div>
        <Suspense
          fallback={
            <p role="status" className="py-6 text-sm text-muted">
              Loading phone sign-in…
            </p>
          }
        >
          <StewardLoginSection phoneOnly />
        </Suspense>
        <p className="text-xs leading-relaxed text-muted">
          By signing in, you agree to the{" "}
          <Link
            to="/terms-of-service"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-sm font-medium text-txt underline underline-offset-4"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            to="/privacy-policy"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-sm font-medium text-txt underline underline-offset-4"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </main>
    </LoginBackground>
  );
}
