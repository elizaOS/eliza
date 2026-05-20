import { MobilePerpsMarketRedirect } from "./client";

export function generateStaticParams() {
  return [{ ticker: "_placeholder" }];
}

export default function Page() {
  return <MobilePerpsMarketRedirect />;
}
