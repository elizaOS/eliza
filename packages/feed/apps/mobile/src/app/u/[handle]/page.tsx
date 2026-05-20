import { MobileUserProfileByHandlePage } from './client';

export function generateStaticParams() {
  return [{ handle: '_placeholder' }];
}

export default function Page() {
  return <MobileUserProfileByHandlePage />;
}
