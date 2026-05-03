"use client";

import { StewardEmailCallback } from "@stwd/react";
import { useRouter } from "next/navigation";
import type React from "react";
import { Suspense } from "react";

function EmailCallbackInner() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-6">
      <div className="w-full max-w-xs text-center">
        <StewardEmailCallback
          redirectTo="/dashboard"
          onSuccess={() => router.push("/dashboard")}
          onError={(err) => console.error("Email callback error:", err)}
        />
      </div>
    </div>
  );
}

export default function EmailCallbackPage() {
  const SuspenseAny = Suspense as React.ComponentType<{
    fallback: React.ReactNode;
    children: React.ReactNode;
  }>;
  return (
    <SuspenseAny
      fallback={
        <div className="min-h-screen bg-bg flex items-center justify-center">
          <span className="w-5 h-5 border border-text-tertiary border-t-accent animate-spin" />
        </div>
      }
    >
      <EmailCallbackInner />
    </SuspenseAny>
  );
}
