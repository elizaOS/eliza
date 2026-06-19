/**
 * Core Eliza character shape (leaf module — avoid importing the types barrel from type modules).
 */

/**
 * Template type for dynamic content generation.
 */
export type TemplateType = string | ((options: { state: Record<string, unknown> }) => string);

/**
 * Character definition for Eliza AI agents.
 */
export interface ElizaCharacter {
  id?: string;
  name: string;
  username?: string;
  system?: string;
  templates?: {
    [key: string]: TemplateType;
  };
  bio: string | string[];
  messageExamples?: Array<
    Array<{
      name: string;
      content: {
        text: string;
        action?: string;
        [key: string]: unknown;
      };
    }>
  >;
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  documents?: (string | { path: string; shared?: boolean })[];
  knowledge?: (string | { path: string; shared?: boolean })[];
  plugins?: string[];
  avatarUrl?: string;
  settings?: Record<string, string | boolean | number | Record<string, unknown>>;
  secrets?: Record<string, string | boolean | number>;
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  isPublic?: boolean;
}
