import type { Metadata } from "next";
import { SessionProvider } from "@/app/components/SessionProvider";
import { isAuthEnabled } from "@/lib/auth-mode";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soulmates",
  description: "Send a thoughtful introduction to Ori in Messages.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authEnabled = isAuthEnabled();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] antialiased font-['Geist',_system-ui,_sans-serif]">
        <SessionProvider authEnabled={authEnabled}>{children}</SessionProvider>
      </body>
    </html>
  );
}
