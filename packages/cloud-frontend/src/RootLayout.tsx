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
 * The layout sets the Open Sans / DM Mono / Inter CSS variables on the body via
 * the className. The Google Fonts imports live in
 * `globals.css` (CSS variables applied on `<body>`).
 */
export default function RootLayout() {
  return (
    <>
      <Helmet>
        <html lang="en" />
        <body className="font-sans antialiased selection:bg-[#FF5800] selection:text-white" />
        <title>eliza cloud - Your cloud agent dashboard</title>
        <meta
          name="description"
          content="Chat with your Eliza agent in the cloud, manage connected devices, account settings, billing, API access, and everything for your cloud agent."
        />
        <link rel="canonical" href={`${baseUrl}/`} />
        <meta
          property="og:title"
          content="eliza cloud - Your cloud agent dashboard"
        />
        <meta
          property="og:description"
          content="Chat with your cloud agent and manage everything for it in one place."
        />
        <meta property="og:url" content={`${baseUrl}/`} />
        <meta property="og:site_name" content="Eliza Cloud" />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:image" content="/cloudlogo.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Eliza Cloud" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Eliza Cloud" />
        <meta
          name="twitter:description"
          content="Chat with your cloud agent and manage devices, billing, settings, and API access."
        />
        <meta name="twitter:image" content="/cloudlogo.png" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/favicon.ico" />
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
              defaultTheme="light"
              enableSystem={false}
              disableTransitionOnChange
            >
              <NavigationProgress />
              <Outlet />
              <Toaster
                richColors
                theme="light"
                position="top-right"
                toastOptions={{
                  style: {
                    background: "rgba(255, 255, 255, 0.82)",
                    border: "1px solid rgba(255, 255, 255, 0.34)",
                    color: "#06131f",
                    backdropFilter: "blur(12px)",
                    borderRadius: "18px",
                  },
                  className: "font-open-sans",
                }}
              />
            </ThemeProvider>
          </CreditsProvider>
        </StewardAuthProvider>
      </StewardWalletProviders>
    </>
  );
}
