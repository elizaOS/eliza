"use client";

import CommentPage from "@web/app/comment/[id]/page";
import { useParams } from "next/navigation";

export function PageContent() {
  const params = useParams<{ id: string }>();
  return <CommentPage params={Promise.resolve({ id: params.id })} />;
}
