import { NavigationProgress, ThemeProvider } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import { CreditsProvider } from "@/lib/providers/CreditsProvider";
import { StewardAuthProvider } from "@/lib/providers/StewardProvider";

const baseUrl =
  import.meta.env.VITE_APP_URL ||
  (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_APP_URL : undefined) ||
  (typeof window !== "undefined" ? window.location.origin : "https://eliza.cloud");

/**
 * Root layout. Wraps every route with:
 *  - global Helmet metadata (title template, OG, twitter, icons, manifest)
 *  - Steward / Credits / Theme providers
 *  - sonner Toaster
 *  - nprogress-driven navigation bar
 *
 * The layout sets the SF Pro / DM Mono / Inter CSS variables on the body via
 * the className. The actual @font-face + Google Fonts imports live in
 * `globals.css` (CSS variables applied on `<body>`).
 */
export default function RootLayout() {
  return (
    <>
      <Helmet>
        <html lang="en" />
        <body className="font-sans antialiased selection:bg-[#FF5800] selection:text-white" />
        <title>Eliza Cloud - Managed Hosting for AI Agents</title>
        <meta
          name="description"
          content="Managed hosting, provisioning, billing, and deployment for AI agents on Eliza Cloud."
        />
        <link rel="canonical" href={`${baseUrl}/`} />
        <meta property="og:title" content="Eliza Cloud - Managed Hosting for AI Agents" />
        <meta
          property="og:description"
          content="Managed hosting, provisioning, billing, and deployment for AI agents"
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
          content="Managed hosting, provisioning, billing, and deployment for AI agents"
        />
        <meta name="twitter:image" content="/cloudlogo.png" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/favicon.ico" />
        <link rel="manifest" href="/site.webmanifest" />
      </Helmet>
      <StewardAuthProvider>
        <CreditsProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
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
                  background: "rgba(0, 0, 0, 0.8)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  color: "white",
                  backdropFilter: "blur(12px)",
                  borderRadius: "0px",
                },
                className: "font-sf-pro",
              }}
            />
          </ThemeProvider>
        </CreditsProvider>
      </StewardAuthProvider>
    </>
  );
}
