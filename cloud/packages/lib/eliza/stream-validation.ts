/**
 * Stream Route Validation Utilities
 * Extracted from stream route to reduce code size and improve reusability
 */

import { z } from "zod";
import { MAX_PROMPT_LENGTH, MAX_RESPONSE_STYLE_LENGTH } from "@/lib/constants/image-generation";

/**
 * Sanitize prompt string to prevent injection attacks
 * Returns false if the string is invalid
 */
export function sanitizePromptString(val: string): boolean {
  // Normalize Unicode before any checks to prevent bypass via different encodings
  val = val.normalize("NFC");

  // Check length - reject suspiciously long prompts
  if (val.length > MAX_PROMPT_LENGTH) {
    return false;
  }

  // Block RTL override and bidirectional control characters (can hide malicious content)
  if (/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(val)) {
    return false;
  }

  // Block zero-width characters that can hide content
  if (/[\u200B-\u200D\uFEFF]/.test(val)) {
    return false;
  }

  // Dangerous literal patterns (case-insensitive)
  const dangerousPatterns = [
    "</system>",
    "<|im_end|>",
    "<|endoftext|>",
    "[INST]",
    "[/INST]",
    "### Instruction:",
    "### Response:",
    "<|assistant|>",
    "<|user|>",
    "\\n\\nHuman:",
    "\\n\\nAssistant:",
  ];

  const lowerVal = val.toLowerCase();
  for (const pattern of dangerousPatterns) {
    if (lowerVal.includes(pattern.toLowerCase())) {
      return false;
    }
  }

  // Check for encoded versions that could bypass literal checks
  const encodedPatterns = [
    /%3C%7C/i, // <|
    /%5D%5D/i, // ]]
    /\\u003c/i, // unicode <
    /\\x3c/i, // hex <
  ];

  for (const pattern of encodedPatterns) {
    if (pattern.test(val)) {
      return false;
    }
  }

  // Reject excessive whitespace or control characters
  if (/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(val)) {
    return false;
  }

  return true;
}

/**
 * Schema for validating client-provided character editor state (including grouped message examples).
 */
export const clientCharacterStateSchema = z
  .object({
    name: z.string().max(100).optional(),
    bio: z.union([z.string(), z.array(z.string())]).optional(),
    system: z.string().optional(),
    adjectives: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    style: z
      .object({
        all: z.array(z.string()).optional(),
        chat: z.array(z.string()).optional(),
        post: z.array(z.string()).optional(),
      })
      .optional(),
    messageExamples: z
      .array(
        z.array(
          z.object({
            name: z.string(),
            content: z.object({
              text: z.string(),
            }),
          }),
        ),
      )
      .optional(),
    avatarUrl: z.string().optional(),
  })
  .passthrough();

/**
 * Schema for app prompt configuration validation
 */
export const appPromptConfigSchema = z
  .object({
    systemPrefix: z
      .string()
      .max(MAX_PROMPT_LENGTH)
      .refine(sanitizePromptString, {
        message: "Invalid characters or patterns in systemPrefix",
      })
      .optional(),
    systemSuffix: z
      .string()
      .max(MAX_PROMPT_LENGTH)
      .refine(sanitizePromptString, {
        message: "Invalid characters or patterns in systemSuffix",
      })
      .optional(),
    responseStyle: z
      .string()
      .max(MAX_RESPONSE_STYLE_LENGTH)
      .refine(sanitizePromptString, {
        message: "Invalid characters or patterns in responseStyle",
      })
      .optional(),
    flirtiness: z.enum(["low", "medium", "high"]).optional(),
    romanticMode: z.boolean().optional(),
    imageGeneration: z
      .object({
        enabled: z.boolean(),
        autoGenerate: z.boolean(),
        defaultVibe: z
          .enum([
            "flirty",
            "shy",
            "bold",
            "spicy",
            "romantic",
            "playful",
            "mysterious",
            "intellectual",
          ])
          .optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Validate appId format (must be UUID)
 */
export function validateAppId(rawAppId: string | null): {
  valid: boolean;
  appId?: string;
  error?: string;
} {
  if (!rawAppId) {
    return { valid: true };
  }

  const result = z.string().uuid().safeParse(rawAppId);
  if (!result.success) {
    return {
      valid: false,
      error: "Invalid appId format - must be a valid UUID",
    };
  }

  return { valid: true, appId: result.data };
}

/**
 * Validate app prompt config
 */
export function validateAppPromptConfig(config: unknown): {
  valid: boolean;
  error?: string;
  details?: z.ZodIssue[];
} {
  if (!config) {
    return { valid: true };
  }

  const result = appPromptConfigSchema.safeParse(config);
  if (!result.success) {
    return {
      valid: false,
      error: "Invalid appPromptConfig format",
      details: result.error.issues,
    };
  }

  return { valid: true };
}
