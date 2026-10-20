import { lazy, Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { alphaSignInLinks } from "../../lib/alpha-sign-in-links";

const StewardLoginSection = lazy(() => import("./steward-login-section"));

// This fixed product surface changes presentation only. The shared section owns
// provider discovery, the Cloud tenant, session recovery and validated returnTo.
const alphaLogo = new URL(
  "../../../../styles/alpha-brand/alpha-logo.svg",
  import.meta.url,
).href;
const publicSans = new URL(
  "../../../../styles/alpha-brand/public-sans-latin.woff2",
  import.meta.url,
).href;
const alphaSignInStyles = `
@font-face { font-family: 'Alpha Public Sans'; src: url('${publicSans}') format('woff2'); font-weight: 300 700; font-style: normal; font-display: swap; }
.alpha-sign-in {
  --bg: #fff; --card: #fff; --text: #000; --text-strong: #000;
  --txt: #000; --foreground: #000; --background: #fff;
  --card-foreground: #000; --muted: #6b6b6b; --muted-strong: #555;
  --muted-foreground: #6b6b6b; --border: #e3e3e3; --border-hover: #000;
  --input: #fff; --bg-hover: #f3f3f3; --bg-accent: #f3f3f3;
  --surface: #f3f3f3; --accent: #000; --accent-hover: #262626;
  --accent-foreground: #fff; --accent-subtle: #f3f3f3; --ring: #000;
  --font-sans: 'Alpha Public Sans', system-ui, sans-serif;
  height: 100dvh; min-height: 0; width: 100%; overflow-y: auto;
  background: #fff; color: #000; font-family: var(--font-sans);
  padding: max(28px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
  box-sizing: border-box;
}
.alpha-sign-in main { width: 100%; max-width: 400px; margin: 0 auto; }
.alpha-sign-in header { margin: 0 0 28px; }
.alpha-sign-in .alpha-logo { display: block; width: 156px; height: 40px; margin: 0 0 28px; filter: invert(1); }
.alpha-sign-in h1 { margin: 0 0 12px; font-size: 28px; font-weight: 500; line-height: 1.2; letter-spacing: -0.8px; }
.alpha-sign-in .alpha-account-note { margin: 0; color: #555; font-size: 14px; line-height: 1.6; }
.alpha-sign-in .alpha-alternative-sign-in > summary { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 44px; padding: 8px 16px; border: 1px solid #e3e3e3; border-radius: 6px; font-size: 14px; cursor: pointer; list-style: none; }
.alpha-sign-in .alpha-alternative-sign-in > summary::-webkit-details-marker { display: none; }
.alpha-sign-in .alpha-alternative-sign-in > summary::after { content: ''; width: 6px; height: 6px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: translateY(-2px) rotate(45deg); }
.alpha-sign-in .alpha-alternative-sign-in[open] > summary { background: #fafafa; }
.alpha-sign-in .alpha-alternative-sign-in[open] > summary::after { transform: translateY(2px) rotate(225deg); }
.alpha-sign-in .alpha-alternative-sign-in > div { margin-top: 16px; }
.alpha-sign-in footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e3e3e3; color: #6b6b6b; font-size: 12px; line-height: 1.5; text-align: center; }
.alpha-sign-in footer p { margin: 0; }
.alpha-sign-in .alpha-legal-links { display: flex; justify-content: center; flex-wrap: wrap; gap: 0 24px; }
.alpha-sign-in footer a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; color: #000; text-decoration: underline; text-underline-offset: 3px; }
.alpha-sign-in :focus-visible { outline: 2px solid #000; outline-offset: 3px; }
.alpha-sign-in [data-login-phone-field]:focus-within { border-color: #000; }
.alpha-sign-in [data-login-phone-field]:focus-within :is(input, button):focus-visible { outline: none; box-shadow: none; }
.alpha-sign-in #steward-login-email:focus { border-color: #000; outline: none; box-shadow: none; }
@media (min-width: 640px) { .alpha-sign-in { padding-top: max(64px, env(safe-area-inset-top)); } }
`;

export default function AlphaSignInPage(): React.JSX.Element {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const links = alphaSignInLinks(searchParams);
  const title = t("cloud.login.alphaSignIn", {
    defaultValue: "Sign in to Alpha",
  });
  useDocumentTitle(title);

  return (
    <div className="alpha-sign-in">
      <style>{alphaSignInStyles}</style>
      <main>
        <header>
          <img
            className="alpha-logo"
            src={alphaLogo}
            alt="Alpha Compute"
            width={156}
            height={40}
          />
          <h1>{title}</h1>
          <p className="alpha-account-note">
            {t("cloud.login.alphaAccountNote", {
              defaultValue: "Use your Eliza Cloud account.",
            })}
          </p>
        </header>
        <Suspense
          fallback={
            <p role="status" className="py-6 text-sm text-muted">
              {t("cloud.login.loadingSignIn", {
                defaultValue: "Loading sign-in options…",
              })}
            </p>
          }
        >
          <StewardLoginSection allowedMethods={["google", "email", "sms"]} />
        </Suspense>
        <footer>
          <p>
            {t("cloud.login.alphaAgreePrefix", {
              defaultValue: "By signing in, you agree to our",
            })}
          </p>
          <div className="alpha-legal-links">
            <Link to={links.terms}>
              {t("cloud.login.termsLink", { defaultValue: "Terms" })}
            </Link>
            <Link to={links.privacy}>
              {t("cloud.login.privacyPolicy", {
                defaultValue: "Privacy Policy",
              })}
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
