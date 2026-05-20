'use client';

import dynamic from 'next/dynamic';

const FullAppShellClient = dynamic(
  () => import('./FullAppShellClient').then((mod) => mod.FullAppShellClient),
  {
    ssr: false,
  }
);

export function FullAppShell({ children }: { children: React.ReactNode }) {
  return <FullAppShellClient>{children}</FullAppShellClient>;
}
