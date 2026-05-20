import { PageContent } from "./client";

export function generateStaticParams() {
  return [{ agentId: "_placeholder" }];
}

export default function Page() {
  return <PageContent />;
}
