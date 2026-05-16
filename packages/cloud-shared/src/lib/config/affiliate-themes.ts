/**
 * Affiliate Theme Configuration System
 *
 * This module provides a scalable theming system for affiliate-created characters.
 * Instead of creating separate routes for each affiliate (not scalable), we use
 * a single /chat route with dynamic theming based on affiliate ID.
 *
 * Usage:
 *   const theme = getAffiliateTheme(affiliateId);
 *   <ChatInterface theme={theme} ... />
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Color values are stored as RGB triplets (e.g., "219 39 119") for alpha channel support.
 * Usage in CSS: rgb(var(--theme-primary)) or rgba(var(--theme-primary), 0.5)
 */
export interface ThemeColors {
  /** Primary brand color - buttons, highlights, user messages */
  primary: string;
  /** Lighter variant of primary - hover states, accents */
  primaryLight: string;
  /** Secondary accent color - badges, icons */
  accent: string;
  /** Background color base */
  background: string;
  /** Gradient start color */
  gradientFrom: string;
  /** Gradient end color */
  gradientTo: string;
}

/**
 * Branding configuration for the affiliate
 */
export interface ThemeBranding {
  /** Display title for the affiliate (used in metadata, headers) */
  title: string;
  /** Tagline/subtitle */
  tagline: string;
  /** Optional logo URL */
  logo?: string;
  /** Favicon URL (optional) */
  favicon?: string;
}

/**
 * UI variant configuration for different visual styles
 */
export interface ThemeVariants {
  /** Intro card style */
  introCard: "romantic" | "professional" | "minimal" | "gaming" | "playful";
  /** Chat bubble border radius style */
  chatBubbles: "rounded" | "sharp" | "soft";
  /** Avatar decoration style */
  avatarStyle: "glow" | "border" | "shadow" | "ring";
  /** Background style */
  backgroundStyle: "gradient" | "solid" | "animated" | "particles";
}

/**
 * Feature flags for the theme
 */
export interface ThemeFeatures {
  /** Show the vibe label badge on intro page */
  showVibeLabel: boolean;
  /** Show the source/affiliate badge */
  showSourceBadge: boolean;
  /** Show animated background effects */
  animatedBackground: boolean;
  /** Show floating decorative elements (hearts, stars, etc.) */
  floatingDecorations: boolean;
  /** Custom emoji set for this theme */
  customEmojis?: string[];
}

/**
 * Complete theme configuration for an affiliate
 */
export interface AffiliateTheme {
  /** Unique identifier for the theme */
  id: string;
  /** Human-readable name */
  name: string;
  /** Branding configuration */
  branding: ThemeBranding;
  /** Color palette */
  colors: ThemeColors;
  /** UI variants */
  variants: ThemeVariants;
  /** Feature flags */
  features: ThemeFeatures;
}

// =============================================================================
// THEME DEFINITIONS
// =============================================================================

export const AFFILIATE_THEMES: Record<string, AffiliateTheme> = {
  /**
   * Default elizaOS Cloud Theme
   * Professional indigo/purple aesthetic
   */
  default: {
    id: "default",
    name: "elizaOS Cloud",
    branding: {
      title: "elizaOS Cloud",
      tagline: "AI-powered conversations",
    },
    colors: {
      primary: "99 102 241", // indigo-500
      primaryLight: "129 140 248", // indigo-400
      accent: "16 185 129", // emerald-500
      background: "9 9 11", // zinc-950
      gradientFrom: "99 102 241", // indigo-500
      gradientTo: "139 92 246", // violet-500
    },
    variants: {
      introCard: "professional",
      chatBubbles: "rounded",
      avatarStyle: "border",
      backgroundStyle: "gradient",
    },
    features: {
      showVibeLabel: true,
      showSourceBadge: false,
      animatedBackground: false,
      floatingDecorations: false,
    },
  },

  // =============================================================================
  // FUTURE AFFILIATE THEMES (Examples)
  // =============================================================================

  // Uncomment and customize when adding new affiliates:

  /*
  "fitness-coach": {
    id: "fitness-coach",
    name: "FitBot AI",
    branding: {
      title: "FitBot AI",
      tagline: "Your personal fitness companion",
    },
    colors: {
      primary: "16 185 129",        // emerald-500
      primaryLight: "52 211 153",   // emerald-400
      accent: "245 158 11",         // amber-500
      background: "9 9 11",
      gradientFrom: "16 185 129",
      gradientTo: "20 184 166",     // teal-500
    },
    variants: {
      introCard: 'professional',
      chatBubbles: 'rounded',
      avatarStyle: 'ring',
      backgroundStyle: 'gradient',
    },
    features: {
      showVibeLabel: false,
      showSourceBadge: true,
      animatedBackground: false,
      floatingDecorations: false,
    },
  },

  "study-buddy": {
    id: "study-buddy",
    name: "Study Buddy",
    branding: {
      title: "Study Buddy",
      tagline: "Your AI learning companion",
    },
    colors: {
      primary: "59 130 246",        // blue-500
      primaryLight: "96 165 250",   // blue-400
      accent: "234 179 8",          // yellow-500
      background: "15 23 42",       // slate-900
      gradientFrom: "59 130 246",
      gradientTo: "99 102 241",     // indigo-500
    },
    variants: {
      introCard: 'minimal',
      chatBubbles: 'soft',
      avatarStyle: 'border',
      backgroundStyle: 'solid',
    },
    features: {
      showVibeLabel: false,
      showSourceBadge: true,
      animatedBackground: false,
      floatingDecorations: false,
    },
  },
  */
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the theme configuration for an affiliate.
 * Falls back to default theme if affiliate ID is not found.
 *
 * @param affiliateId - The affiliate identifier
 * @returns The theme configuration
 */
export function getAffiliateTheme(affiliateId: string | undefined | null): AffiliateTheme {
  if (!affiliateId) {
    return AFFILIATE_THEMES["default"];
  }

  return AFFILIATE_THEMES[affiliateId] || AFFILIATE_THEMES["default"];
}

/**
 * Get all registered affiliate IDs
 */
export function getAffiliateIds(): string[] {
  return Object.keys(AFFILIATE_THEMES);
}

/**
 * Check if an affiliate theme exists
 */
export function hasAffiliateTheme(affiliateId: string): boolean {
  return affiliateId in AFFILIATE_THEMES;
}

/**
 * Generate CSS custom properties object from theme colors.
 * Use this to apply theme colors as inline styles on container elements.
 *
 * @param theme - The affiliate theme
 * @returns CSS properties object
 */
export function getThemeCSSVariables(theme: AffiliateTheme): React.CSSProperties {
  return {
    "--theme-primary": theme.colors.primary,
    "--theme-primary-light": theme.colors.primaryLight,
    "--theme-accent": theme.colors.accent,
    "--theme-background": theme.colors.background,
    "--theme-gradient-from": theme.colors.gradientFrom,
    "--theme-gradient-to": theme.colors.gradientTo,
  } as React.CSSProperties;
}

/**
 * Get the affiliate ID from character metadata.
 * Checks character_data.affiliate.affiliateId
 *
 * @param characterData - The character_data field from a character
 * @returns The affiliate ID or undefined
 */
export function getAffiliateIdFromCharacter(
  characterData: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!characterData) return undefined;

  const affiliate = characterData.affiliate as
    | { affiliateId?: string; [key: string]: unknown }
    | undefined;
  if (!affiliate) return undefined;

  return affiliate.affiliateId;
}

/**
 * Resolve the theme for a character based on URL params and character metadata.
 * Priority: URL source param > character metadata > default
 *
 * @param source - The source URL parameter
 * @param characterData - The character's character_data field
 * @returns The resolved affiliate theme
 */
export function resolveCharacterTheme(
  source: string | undefined | null,
  characterData: Record<string, unknown> | undefined | null,
): AffiliateTheme {
  // Priority 1: URL source parameter
  if (source && hasAffiliateTheme(source)) {
    return getAffiliateTheme(source);
  }

  // Priority 2: Character metadata
  const affiliateId = getAffiliateIdFromCharacter(characterData);
  if (affiliateId && hasAffiliateTheme(affiliateId)) {
    return getAffiliateTheme(affiliateId);
  }

  // Priority 3: Default theme
  return AFFILIATE_THEMES["default"];
}
