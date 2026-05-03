"use client";

import { StewardLogin } from "@stwd/react";
import Image from "next/image";
import { useRouter } from "next/navigation";

const Logo = (
  <div className="flex items-center justify-center gap-2.5">
    <Image src="/logo.png" alt="" width={28} height={28} className="w-7 h-7 opacity-70" />
    <span className="font-display text-xl font-bold tracking-tight">steward</span>
  </div>
);

export default function LoginPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 sm:px-6">
      <div className="w-full max-w-sm">
        <StewardLogin
          variant="card"
          title="Sign in to Steward"
          subtitle="Manage your agents, wallets, and policies"
          logo={Logo}
          onSuccess={() => router.push("/dashboard")}
          onError={(err) => console.error("Login error:", err)}
        />
      </div>
    </div>
  );
}
