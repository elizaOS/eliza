import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ELIZA Chat - elizaOS Next.js Demo",
  description: "Chat with ELIZA powered by elizaOS AgentRuntime",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
