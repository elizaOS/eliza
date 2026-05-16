import { NavigationProgress, ThemeProvider } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import { StewardWalletProviders } from "@/pages/login/steward-wallet-providers";
import { CreditsProvider } from "@/providers/CreditsProvider";
import { StewardAuthProvider } from "@/providers/StewardProvider";

const baseUrl =
  import.meta.env.VITE_APP_URL ||
  (typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_APP_URL
    : undefined) ||
  (typeof window !== "undefined"
    ? window.location.origin
    : "https://eliza.cloud");

/**
 * Root layout. Wraps every route with:
 *  - global Helmet metadata (title template, OG, twitter, icons, manifest)
 *  - Steward / Credits / Theme providers
 *  - sonner Toaster
 *  - nprogress-driven navigation bar
 *
 * The layout sets the Poppins font class on the body.
 * The vendored font import lives in `globals.css`.
 */
export default function RootLayout() {
  return (
    <>
      <Helmet>
        <html lang="en" />
        <body className="font-sans antialiased selection:bg-[#FF5800] selection:text-white" />
        <title>eliza cloud - Run in Cloud</title>
        <meta
          name="description"
          content="Run your Eliza agent in Cloud. Sign in or preorder ElizaOS hardware."
        />
        <link rel="canonical" href={`${baseUrl}/`} />
        <meta property="og:title" content="eliza cloud - Run in Cloud" />
        <meta
          property="og:description"
          content="Run your Eliza agent in Cloud. Sign in or preorder ElizaOS hardware."
        />
        <meta property="og:url" content={`${baseUrl}/`} />
        <meta property="og:site_name" content="Eliza Cloud" />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="en_US" />
        <meta
          property="og:image"
          content="/brand/logos/logo_white_blackbg.svg"
        />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Eliza Cloud" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Eliza Cloud" />
        <meta
          name="twitter:description"
          content="Run your Eliza agent in Cloud. Sign in or preorder ElizaOS hardware."
        />
        <meta
          name="twitter:image"
          content="/brand/logos/logo_white_blackbg.svg"
        />
        <link
          rel="icon"
          type="image/svg+xml"
          href="/brand/favicons/favicon.svg"
        />
        <link rel="alternate icon" href="/brand/favicons/favicon.ico" />
        <link rel="shortcut icon" href="/brand/favicons/favicon.ico" />
        <link
          rel="apple-touch-icon"
          href="/brand/favicons/apple-touch-icon.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
      </Helmet>
      {/*
       * StewardAuthProvider — client-only. Wraps Steward SDK session, syncs JWT
       * to the API client on every auth-state change. No server logic.
       *
       * CreditsProvider — client-only. Polls /api/credits for the current user's
       * credit balance; provides useCredits() hook. Single polling instance prevents
       * duplicate requests from sibling components reading the same value.
       *
       * ThemeProvider — client-only. Reads user preference from localStorage + OS
       * and sets the "dark" / "light" class on <html> for Tailwind dark-mode.
       */}
      <StewardWalletProviders>
        <StewardAuthProvider>
          <CreditsProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="dark"
              enableSystem={false}
              disableTransitionOnChange
            >
              <NavigationProgress />
              <Outlet />
              <Toaster
                richColors
                theme="dark"
                position="top-right"
                toastOptions={{
                  style: {
                    background: "#000000",
                    border: "1px solid rgba(255, 255, 255, 0.14)",
                    color: "#FFFFFF",
                    borderRadius: "2px",
                  },
                  className: "font-poppins",
                }}
              />
            </ThemeProvider>
          </CreditsProvider>
        </StewardAuthProvider>
      </StewardWalletProviders>
    </>
  );
}
