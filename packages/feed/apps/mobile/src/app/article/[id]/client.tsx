'use client';

import ArticlePage from '@web/app/article/[id]/page';
import { useParams } from 'next/navigation';

export function PageContent() {
  const params = useParams<{ id: string }>();
  return <ArticlePage params={Promise.resolve({ id: params.id })} />;
}
