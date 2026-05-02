"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";

export function Nav() {
  return (
    <motion.nav
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] }}
      className="fixed top-0 left-0 right-0 z-50 px-6 md:px-10 py-5 flex items-center justify-between"
      style={{
        background: "linear-gradient(to bottom, rgba(11,10,9,0.95) 0%, rgba(11,10,9,0) 100%)",
      }}
    >
      <Link href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
        <Image src="/logo.png" alt="Steward" width={24} height={24} className="w-6 h-6" />
        <span className="font-display text-lg font-bold tracking-tight text-text">steward</span>
      </Link>

      <div className="flex items-center gap-8">
        <a
          href="https://docs.steward.fi"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-text-secondary hover:text-text transition-colors"
        >
          Docs
        </a>
        <a
          href="https://github.com/Steward-Fi/steward"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-text-secondary hover:text-text transition-colors"
        >
          GitHub
        </a>
        <Link
          href="/dashboard"
          className="text-sm px-4 py-2 bg-accent/10 text-[oklch(0.75_0.15_55)] hover:bg-accent/20 transition-colors"
        >
          Dashboard
        </Link>
      </div>
    </motion.nav>
  );
}
