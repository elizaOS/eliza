"use client";

import { motion } from "motion/react";

/**
 * Dashboard template component providing page transition animations.
 * Wraps dashboard pages with fade and slide animations.
 *
 * @param children - The page content to render with animations.
 * @returns The animated page content.
 */
export default function DashboardTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{
        duration: 0.3,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}
