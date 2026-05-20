import { PageContent } from './client';

export function generateStaticParams() {
  return [{ tag: '_placeholder' }];
}

export default function Page() {
  return <PageContent />;
}
