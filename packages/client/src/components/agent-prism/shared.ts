import type { TraceSpanCategory } from '@evilmartians/agent-prism-types';

import {
  Zap,
  Wrench,
  Bot,
  Link,
  Search,
  BarChart2,
  Plus,
  HelpCircle,
  MoveHorizontal,
  type LucideIcon,
  CircleDot,
  ShieldCheck,
} from 'lucide-react';

// TYPES

export type ColorVariant =
  | 'purple'
  | 'indigo'
  | 'orange'
  | 'teal'
  | 'cyan'
  | 'sky'
  | 'yellow'
  | 'emerald'
  | 'red'
  | 'gray';

export type ComponentSize = '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12' | '16';

// CONSTANTS

export const ROUNDED_CLASSES = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * Unified color theme classes for consistent styling across components
 */
export const COLOR_THEME_CLASSES: Record<
  ColorVariant,
  {
    bg: string;
    darkBg: string;
    text: string;
    darkText: string;
  }
> = {
  purple: {
    bg: 'bg-purple-100',
    darkBg: 'dark:bg-purple-950/60',
    text: 'text-purple-500',
    darkText: 'dark:text-purple-300',
  },
  indigo: {
    bg: 'bg-indigo-100',
    darkBg: 'dark:bg-indigo-950/60',
    text: 'text-indigo-500',
    darkText: 'dark:text-indigo-300',
  },
  orange: {
    bg: 'bg-orange-100',
    darkBg: 'dark:bg-orange-950/60',
    text: 'text-orange-600',
    darkText: 'dark:text-orange-300',
  },
  teal: {
    bg: 'bg-teal-100',
    darkBg: 'dark:bg-teal-950/60',
    text: 'text-teal-600',
    darkText: 'dark:text-teal-300',
  },
  cyan: {
    bg: 'bg-cyan-100',
    darkBg: 'dark:bg-cyan-950/60',
    text: 'text-cyan-600',
    darkText: 'dark:text-cyan-300',
  },
  sky: {
    bg: 'bg-sky-100',
    darkBg: 'dark:bg-sky-950/60',
    text: 'text-sky-600',
    darkText: 'dark:text-sky-300',
  },
  yellow: {
    bg: 'bg-yellow-100',
    darkBg: 'dark:bg-yellow-950/60',
    text: 'text-yellow-700',
    darkText: 'dark:text-yellow-300',
  },
  emerald: {
    bg: 'bg-emerald-100',
    darkBg: 'dark:bg-emerald-950/60',
    text: 'text-emerald-600',
    darkText: 'dark:text-emerald-300',
  },
  red: {
    bg: 'bg-red-100',
    darkBg: 'dark:bg-red-950/60',
    text: 'text-red-600',
    darkText: 'dark:text-red-300',
  },
  gray: {
    bg: 'bg-gray-100',
    darkBg: 'dark:bg-gray-900',
    text: 'text-gray-600',
    darkText: 'dark:text-gray-300',
  },
};

/**
 * Shared configuration for span categories containing label, theme, and icon
 */
export const SPAN_CATEGORY_CONFIG: Record<
  TraceSpanCategory,
  {
    label: string;
    theme: ColorVariant;
    icon: LucideIcon;
  }
> = {
  llm_call: {
    label: 'LLM',
    theme: 'purple',
    icon: Zap,
  },
  tool_execution: {
    label: 'TOOL',
    theme: 'orange',
    icon: Wrench,
  },
  agent_invocation: {
    label: 'AGENT INVOCATION',
    theme: 'indigo',
    icon: Bot,
  },
  chain_operation: {
    label: 'CHAIN',
    theme: 'teal',
    icon: Link,
  },
  retrieval: {
    label: 'RETRIEVAL',
    theme: 'cyan',
    icon: Search,
  },
  embedding: {
    label: 'EMBEDDING',
    theme: 'emerald',
    icon: BarChart2,
  },
  create_agent: {
    label: 'CREATE AGENT',
    theme: 'sky',
    icon: Plus,
  },
  span: {
    label: 'SPAN',
    theme: 'cyan',
    icon: MoveHorizontal,
  },
  event: {
    label: 'EVENT',
    theme: 'emerald',
    icon: CircleDot,
  },
  guardrail: {
    label: 'GUARDRAIL',
    theme: 'red',
    icon: ShieldCheck,
  },
  unknown: {
    label: 'UNKNOWN',
    theme: 'gray',
    icon: HelpCircle,
  },
};

// UTILS

export function getSpanCategoryTheme(category: TraceSpanCategory): ColorVariant {
  return SPAN_CATEGORY_CONFIG[category].theme;
}

export function getSpanCategoryLabel(category: TraceSpanCategory): string {
  return SPAN_CATEGORY_CONFIG[category].label;
}

export function getSpanCategoryIcon(category: TraceSpanCategory): LucideIcon {
  return SPAN_CATEGORY_CONFIG[category].icon;
}
