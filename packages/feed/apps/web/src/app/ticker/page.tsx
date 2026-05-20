import type { Metadata } from "next";
import { TickerClient } from "./TickerClient";

export const metadata: Metadata = {
  title: "Feed Ticker",
  description:
    "Live ticker: news, prediction markets, and perps. Embed on your site or livestream.",
  robots: "noindex, nofollow",
};

/**
 * Ticker embed page – minimal layout (no nav/sidebar), iframe-friendly.
 * Query params: streams, theme, speed, height (see TickerClient).
 */
export default function TickerPage() {
  return (
    <div className="min-h-dvh w-full md:min-h-screen">
      <TickerClient />
    </div>
  );
}
