import type { ReactNode } from "react";

const alphaLogo = new URL(
  "../../../../styles/alpha-brand/alpha-logo.svg",
  import.meta.url,
).href;
const publicSans = new URL(
  "../../../../styles/alpha-brand/public-sans-latin.woff2",
  import.meta.url,
).href;
const styles = `
@font-face { font-family: 'Alpha Public Sans'; src: url('${publicSans}') format('woff2'); font-weight: 300 700; font-style: normal; font-display: swap; }
.alpha-legal {
  --bg: #fff; --text: #000; --txt: #000; --muted: #6b6b6b;
  --muted-strong: #000; --border: #e3e3e3;
  --font-sans: 'Alpha Public Sans', system-ui, sans-serif;
  height: 100dvh; min-height: 0; overflow-y: auto;
  background: #fff; color: #000; font-family: var(--font-sans);
}
.alpha-legal main { padding: max(28px, env(safe-area-inset-top)) 24px max(32px, env(safe-area-inset-bottom)); }
.alpha-legal-content { max-width: 68ch; }
.alpha-legal-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.alpha-legal-header img { display: block; width: 156px; height: 40px; filter: invert(1); }
.alpha-legal-header a, .alpha-legal-footer a { display: inline-flex; align-items: center; min-height: 44px; color: #000; }
.alpha-legal h1 { font-size: 28px; line-height: 1.2; font-weight: 500; letter-spacing: -0.8px; }
.alpha-legal h2 { font-size: 20px; line-height: 1.4; font-weight: 500; }
.alpha-legal p, .alpha-legal li { overflow-wrap: anywhere; }
.alpha-legal-footer { align-items: flex-start; }
.alpha-legal :focus-visible { outline: 2px solid #0000ff; outline-offset: 3px; }
@media (min-width: 640px) { .alpha-legal main { padding-top: max(48px, env(safe-area-inset-top)); } }
`;

/** Alpha presentation only; the shared pages keep their legal copy and route links. */
export function AlphaLegalHeader({ children }: { children: ReactNode }) {
  return (
    <header className="alpha-legal-header">
      <style>{styles}</style>
      <img src={alphaLogo} alt="Alpha Compute" width={156} height={40} />
      {children}
    </header>
  );
}
