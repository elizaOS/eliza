"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiUrl } from "@/utils/api-url";

export function MobileProfileResolvePage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const identifier = decodeURIComponent(id);

    async function resolve() {
      const response = await fetch(
        apiUrl(`/api/profiles/resolve/${encodeURIComponent(identifier)}`),
      );

      if (response.status === 404) {
        router.replace("/");
        return;
      }

      if (!response.ok) {
        setError("Failed to resolve profile");
        return;
      }

      const data = await response.json();
      if (data.redirect) {
        router.replace(data.redirect);
      } else {
        router.replace("/");
      }
    }

    resolve();
  }, [id, router]);

  if (error) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-4">
        <p className="text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  );
}
