"use client";

import { StewardAuthGuard, StewardUserButton } from "@stwd/react";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

function RedirectToLogin() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-5 h-5 border border-text-tertiary border-t-accent animate-spin" />
    </div>
  );
}

const links = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/agents", label: "Agents" },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/transactions", label: "Transactions" },
  { href: "/dashboard/secrets", label: "Secrets" },
  { href: "/dashboard/policies", label: "Policies" },
  { href: "/dashboard/audit", label: "Audit" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/tenants", label: "Tenants" },
];

function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname?.startsWith(href) ?? false;
  }

  // Close menu on outside click
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen, handleClickOutside]);

  // Close menu on navigation
  useEffect(() => {
    setMenuOpen(false);
  }, []);

  const activeLabel = links.find((l) => isActive(l.href, l.exact))?.label ?? "Dashboard";

  return (
    <header className="border-b border-border sticky top-0 z-40 bg-bg/90 backdrop-blur-sm">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 md:px-10">
        <div className="flex items-center justify-between h-14 gap-4">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0"
          >
            <Image src="/logo.png" alt="Steward" width={20} height={20} className="w-5 h-5" />
            <span className="font-display text-base font-bold tracking-tight text-text hidden sm:inline">
              steward
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 flex-1 min-w-0">
            {links.map((link) => {
              const active = isActive(link.href, link.exact);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative px-3 py-1.5 text-sm transition-colors whitespace-nowrap ${
                    active ? "text-text" : "text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  {link.label}
                  {active && (
                    <motion.div
                      layoutId="dashboard-nav-indicator"
                      className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent"
                      transition={{
                        type: "tween",
                        duration: 0.25,
                        ease: [0.25, 1, 0.5, 1],
                      }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Mobile hamburger */}
          <div className="flex md:hidden items-center gap-3 flex-1 min-w-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm text-text-secondary hover:text-text transition-colors"
              aria-label="Toggle menu"
            >
              {/* Hamburger icon */}
              <div className="flex flex-col gap-[3px]">
                <span
                  className={`block w-4 h-[1.5px] bg-current transition-transform ${menuOpen ? "rotate-45 translate-y-[5px]" : ""}`}
                />
                <span
                  className={`block w-4 h-[1.5px] bg-current transition-opacity ${menuOpen ? "opacity-0" : ""}`}
                />
                <span
                  className={`block w-4 h-[1.5px] bg-current transition-transform ${menuOpen ? "-rotate-45 -translate-y-[5px]" : ""}`}
                />
              </div>
              <span className="text-xs text-text-tertiary truncate">{activeLabel}</span>
            </button>

            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-14 left-0 right-0 bg-bg border-b border-border z-50 shadow-lg"
                >
                  <div className="max-w-[1400px] mx-auto px-4 py-2">
                    {links.map((link) => {
                      const active = isActive(link.href, link.exact);
                      return (
                        <Link
                          key={link.href}
                          href={link.href}
                          className={`block px-3 py-2.5 text-sm transition-colors ${
                            active
                              ? "text-text bg-bg-surface"
                              : "text-text-tertiary hover:text-text hover:bg-bg-hover"
                          }`}
                        >
                          {link.label}
                        </Link>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* User button */}
          <StewardUserButton onSignOut={() => router.push("/login")} />
        </div>
      </div>
    </header>
  );
}

function LoadingSpinner() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-5 h-5 border border-text-tertiary border-t-accent animate-spin" />
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <StewardAuthGuard fallback={<RedirectToLogin />} loadingFallback={<LoadingSpinner />}>
      <div className="min-h-screen bg-bg">
        <DashboardNav />
        <main className="max-w-[1400px] mx-auto px-4 md:px-6 lg:px-10 py-6 md:py-8 lg:py-12">
          {children}
        </main>
      </div>
    </StewardAuthGuard>
  );
}
