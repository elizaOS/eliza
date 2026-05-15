import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PrivyProvider } from "@/providers/PrivyProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Clone Your Crush | AI-Powered Chat",
  description: "Create an AI clone of your crush and chat with them. Powered by ElizaOS.",
  keywords: ["AI", "chat", "crush", "artificial intelligence", "ElizaOS"],
  openGraph: {
    title: "Clone Your Crush",
    description: "Create an AI clone of your crush and chat with them",
    url: "https://cloneyourcrush.com",
    siteName: "Clone Your Crush",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clone Your Crush",
    description: "Create an AI clone of your crush and chat with them",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes"
        />
      </head>
      <body className={inter.className}>
        <PrivyProvider>{children}</PrivyProvider>
      </body>
    </html>
  );
}
