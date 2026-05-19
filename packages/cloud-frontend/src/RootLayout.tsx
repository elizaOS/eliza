import {
  BRAND_COLORS,
  BRAND_FAVICONS,
  BRAND_PATHS,
  OG_EMBED_FILES,
} from "@elizaos/shared/brand";
import { NavigationProgress, ThemeProvider } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import { ConditionalWalletProviders } from "@/providers/ConditionalWalletProviders";
import { CreditsProvider } from "@/providers/CreditsProvider";
import { useI18n } from "@/providers/I18nProvider";
import { StewardAuthProvider } from "@/providers/StewardProvider";

const ogImage = `${BRAND_PATHS.ogembeds}/${OG_EMBED_FILES.cloud}`;

const baseUrl =
  import.meta.env.VITE_APP_URL ||
  (typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_APP_URL
    : undefined) ||
  (typeof window !== "undefined"
    ? window.location.origin
    : "https://eliza.cloud");

const OG_LOCALES: Record<string, string> = {
  en: "en_US",
  es: "es_ES",
  pt: "pt_BR",
  ko: "ko_KR",
  ja: "ja_JP",
  vi: "vi_VN",
  tl: "tl_PH",
  "zh-CN": "zh_CN",
};

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
  const { lang, t } = useI18n();

  const title = t("cloud.meta.indexTitle", {
    defaultValue: "Eliza Cloud - Launch Eliza",
  });
  const description = t("cloud.meta.indexDescription", {
    defaultValue:
      "Launch your Eliza agent in the cloud or open the developer dashboard.",
  });
  const ogTitle = t("cloud.meta.ogTitle", {
    defaultValue: "Eliza Cloud - Launch Eliza",
  });
  const twitterTitle = t("cloud.meta.twitterTitle", {
    defaultValue: "Eliza Cloud",
  });
  const ogImageAlt = t("cloud.meta.ogImageAlt", {
    defaultValue: "Eliza Cloud",
  });
  const skipToContent = t("cloud.layout.skipToContent", {
    defaultValue: "Skip to content",
  });
  const ogLocale = OG_LOCALES[lang] ?? OG_LOCALES.en;

  return (
    <>
      <Helmet>
        <html lang={lang} />
        <body className="font-sans antialiased selection:bg-[#FF5800] selection:text-white" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={`${baseUrl}/`} />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={`${baseUrl}/`} />
        <meta property="og:site_name" content="Eliza Cloud" />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content={ogLocale} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={ogImageAlt} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={twitterTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={ogImage} />
        <link rel="icon" type="image/svg+xml" href={BRAND_FAVICONS.svg} />
        <link rel="alternate icon" href={BRAND_FAVICONS.ico} />
        <link rel="shortcut icon" href={BRAND_FAVICONS.ico} />
        <link rel="apple-touch-icon" href={BRAND_FAVICONS.appleTouchIcon} />
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
      <ConditionalWalletProviders>
        <StewardAuthProvider>
          <CreditsProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="dark"
              enableSystem={false}
              disableTransitionOnChange
            >
              <NavigationProgress />
              <a
                href="#main"
                className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[#FF5800]"
              >
                {skipToContent}
              </a>
              <Outlet />
              <Toaster
                richColors
                theme="dark"
                position="top-right"
                toastOptions={{
                  style: {
                    background: BRAND_COLORS.black,
                    border: "1px solid rgba(255, 255, 255, 0.14)",
                    color: BRAND_COLORS.white,
                    borderRadius: "2px",
                  },
                  className: "font-poppins",
                }}
              />
            </ThemeProvider>
          </CreditsProvider>
        </StewardAuthProvider>
      </ConditionalWalletProviders>
    </>
  );
}
