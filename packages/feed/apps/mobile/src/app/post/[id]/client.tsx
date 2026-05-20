'use client';

import PostPage from '@web/app/post/[id]/page';
import { useParams } from 'next/navigation';

export function PageContent() {
  const params = useParams<{ id: string }>();
  return <PostPage params={Promise.resolve({ id: params.id })} />;
}
