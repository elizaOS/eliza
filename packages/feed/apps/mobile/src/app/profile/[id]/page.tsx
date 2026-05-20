import { MobileProfileResolvePage } from "./client";

export function generateStaticParams() {
  return [{ id: "_placeholder" }];
}

export default function Page() {
  return <MobileProfileResolvePage />;
}
