import type { Metadata } from "next";
import "./globals.css";
import "@stwd/react/styles.css";
import { Providers } from "@/components/providers";

const metadataBase = (() => {
  const url = process.env.NEXT_PUBLIC_STEWARD_WEB_URL ?? "https://steward.fi";
  try {
    return new URL(url);
  } catch {
    return new URL("https://steward.fi");
  }
})();

export const metadata: Metadata = {
  metadataBase,
  title: "Steward — Agent Wallet Infrastructure",
  description:
    "Managed wallets for AI agents with policy enforcement, multi-tenant isolation, and webhook-driven approvals. Self-hosted.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Steward — Agent Wallet Infrastructure",
    description: "Managed wallets for AI agents. Policy enforcement. Self-hosted.",
    type: "website",
    images: [
      {
        url: "/logo.png",
        width: 1463,
        height: 1463,
        alt: "Steward compass star logo",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="noise-overlay">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
