"use client";

import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

type CubicBezier = [number, number, number, number];

const easeOutExpo: CubicBezier = [0.16, 1, 0.3, 1];
const easeOutQuart: CubicBezier = [0.25, 1, 0.5, 1];

interface RevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: "up" | "down" | "left" | "right" | "none";
  duration?: number;
  once?: boolean;
  amount?: number;
}

const directionOffset = {
  up: { y: 24 },
  down: { y: -24 },
  left: { x: 24 },
  right: { x: -24 },
  none: {},
};

export function Reveal({
  children,
  className,
  delay = 0,
  direction = "up",
  duration = 0.6,
  once = true,
  amount = 0.3,
}: RevealProps) {
  return (
    <motion.div
      initial={{
        opacity: 0,
        ...directionOffset[direction],
      }}
      whileInView={{
        opacity: 1,
        x: 0,
        y: 0,
      }}
      viewport={{ once, amount }}
      transition={{
        duration,
        delay,
        ease: easeOutExpo,
      }}
      className={className}
    >
      {children as any}
    </motion.div>
  );
}

interface StaggerContainerProps {
  children: ReactNode;
  className?: string;
  staggerDelay?: number;
  once?: boolean;
}

const _containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: easeOutQuart,
    },
  },
};

export function StaggerContainer({
  children,
  className,
  staggerDelay = 0.1,
  once = true,
}: StaggerContainerProps) {
  return (
    <motion.div
      variants={{
        hidden: {},
        visible: {
          transition: { staggerChildren: staggerDelay },
        },
      }}
      initial="hidden"
      whileInView="visible"
      viewport={{ once, amount: 0.2 }}
      className={className}
    >
      {children as any}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={itemVariants} className={className}>
      {children as any}
    </motion.div>
  );
}

export function FadeIn({
  children,
  className,
  delay = 0,
  duration = 0.5,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration,
        delay,
        ease: easeOutQuart,
      }}
      className={className}
    >
      {children as any}
    </motion.div>
  );
}
