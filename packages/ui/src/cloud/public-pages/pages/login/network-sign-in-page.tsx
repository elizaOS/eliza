import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { LoginBackground } from "./login-page";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

export default function NetworkSignInPage(): React.JSX.Element {
  const t = useCloudT();
  const title = t("cloud.login.networkSignIn", {
    defaultValue: "Sign in to The Network",
  });
  useDocumentTitle(title);

  return (
    <LoginBackground plain>
      <main className="space-y-8">
        <h1 className="font-sans text-3xl font-semibold tracking-tight text-txt-strong">
          {title}
        </h1>
        <Suspense
          fallback={
            <p role="status" className="py-6 text-sm text-muted">
              {t("cloud.login.loadingPhoneSignIn", {
                defaultValue: "Loading phone sign-in…",
              })}
            </p>
          }
        >
          <StewardLoginSection phoneOnly />
        </Suspense>
        <p className="text-xs leading-relaxed text-muted">
          {t("cloud.login.agreePrefix", {
            defaultValue: "By signing in, you agree to the",
          })}{" "}
          <Link
            to="/terms-of-service"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-sm font-medium text-txt underline underline-offset-4"
          >
            {t("cloud.login.termsLink", { defaultValue: "Terms" })}
          </Link>{" "}
          {t("cloud.login.and", { defaultValue: "and" })}{" "}
          <Link
            to="/privacy-policy"
            className="hosted-signin-focus-emphasis inline-flex min-h-touch items-center rounded-sm font-medium text-txt underline underline-offset-4"
          >
            {t("cloud.login.privacyPolicy", {
              defaultValue: "Privacy Policy",
            })}
          </Link>
          .
        </p>
      </main>
    </LoginBackground>
  );
}
