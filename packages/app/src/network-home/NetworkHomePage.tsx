/**
 * eliza.app home page once Eliza is The Network's agent. Mounted as the
 * CloudRouterShell `marketingHomeElement` only when NETWORK_HOME_ENABLED
 * (VITE_NETWORK_HOME=1); the wording is a DRAFT pending founder approval.
 */
import { useEffect } from "react";
import {
  NETWORK_HOME_COPY as copy,
  NETWORK_LINE_DISPLAY,
  NETWORK_LINE_E164,
  networkLineSmsHref,
} from "./network-home-copy";

export function NetworkHomePage(): React.JSX.Element {
  useEffect(() => {
    document.title = copy.metaTitle;
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center bg-[#fdfaf7] px-4 py-16 text-black">
      <div className="flex w-full max-w-xl flex-col gap-10">
        <header className="flex flex-col gap-4">
          <p className="text-sm font-medium uppercase tracking-wide text-black/60">
            {copy.eyebrow}
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            {copy.headline}
          </h1>
          <p className="text-lg leading-relaxed text-black/75">
            {copy.subhead}
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <a
              href={networkLineSmsHref()}
              className="rounded-full bg-black px-6 py-3 text-base font-medium text-white hover:bg-black/85"
            >
              {copy.primaryCta}
            </a>
            <a
              href={copy.networkHref}
              className="rounded-full border border-black/20 px-6 py-3 text-base font-medium hover:border-black/50"
            >
              {copy.secondaryCta}
            </a>
          </div>
          <p className="text-sm text-black/60">
            {copy.numberLabel}{" "}
            <a className="underline" href={`tel:${NETWORK_LINE_E164}`}>
              {NETWORK_LINE_DISPLAY}
            </a>
          </p>
        </header>

        <section aria-labelledby="network-apps" className="flex flex-col gap-3">
          <h2 id="network-apps" className="text-base font-semibold">
            {copy.appsHeading}
          </h2>
          <ul className="flex flex-col gap-2">
            {copy.apps.map((app) => (
              <li key={app.name}>
                <a
                  href={app.href}
                  className="flex flex-col rounded-xl border border-black/10 px-4 py-3 hover:border-black/30"
                >
                  <span className="font-medium">{app.name}</span>
                  <span className="text-sm text-black/65">{app.line}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="network-existing-users"
          className="flex flex-col gap-2 rounded-xl bg-black/[0.04] px-4 py-4"
        >
          <h2 id="network-existing-users" className="text-base font-semibold">
            {copy.existingUsersHeading}
          </h2>
          <p className="text-sm leading-relaxed text-black/75">
            {copy.existingUsersBody}
          </p>
        </section>

        <footer className="flex flex-col gap-2 text-xs text-black/55">
          <p>{copy.footer}</p>
          <p>
            <a className="underline" href="/terms-of-service">
              Terms
            </a>{" "}
            ·{" "}
            <a className="underline" href="/privacy-policy">
              Privacy
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}

export default NetworkHomePage;
