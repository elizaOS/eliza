"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function MobileRegistryRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin?tab=registry");
  }, [router]);
  return null;
}
