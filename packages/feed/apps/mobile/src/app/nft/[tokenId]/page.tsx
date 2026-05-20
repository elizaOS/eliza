import { PageContent } from './client';

export function generateStaticParams() {
  return [{ tokenId: '_placeholder' }];
}

export default function Page() {
  return <PageContent />;
}
