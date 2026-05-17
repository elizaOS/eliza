/**
 * Zod schema for the POST /api/onboarding endpoint.
 *
 * The onboarding payload is large (~30 optional fields) and many
 * deeply-nested sections (`deploymentTarget`, `linkedAccounts`,
 * `serviceRouting`, `credentialInputs`, `connectors`, `features`,
 * `inventoryProviders`) are post-processed by dedicated normalization
 * helpers (`normalizeDeploymentTargetConfig`, etc.). The schema
 * therefore:
 *   1. Enforces the only hard required field (`name`)
 *   2. Rejects the documented legacy field set with one tailored error
 *   3. Type-checks each known top-level optional field
 *   4. Lets the existing normalization helpers handle the deep shape
 *      via `passthrough()` for the structured sections
 *
 * That keeps validation honest at the boundary without duplicating
 * the normalization helpers.
 */

import z from "zod";

export const ONBOARDING_LEGACY_FIELD_KEYS = [
  "connection",
  "runMode",
  "cloudProvider",
  "provider",
  "providerApiKey",
  "primaryModel",
  "nanoModel",
  "smallModel",
  "mediumModel",
  "largeModel",
  "megaModel",
] as const;

const OnboardingThemeSchema = z.enum([
  "eliza",
  "qt314",
  "web2000",
  "programmer",
  "haxor",
  "psycho",
]);

const OnboardingStyleSchema = z
  .object({
    all: z.array(z.string()).optional(),
    chat: z.array(z.string()).optional(),
    post: z.array(z.string()).optional(),
  })
  .strict();

/**
 * `messageExamples` accepts two historical shapes:
 *   - new: { examples: [{ name, content: { text } }] }
 *   - old: [{ user|name, content: { text } }, ...]
 * The handler normalizes both. Schema accepts either by typing the
 * outer items as `unknown` and trusting the per-item normalization.
 */
const MessageExamplesItemSchema = z.unknown();

const InventoryProviderEntrySchema = z
  .object({
    chain: z.string(),
    rpcProvider: z.string(),
    rpcApiKey: z.string().optional(),
  })
  .strict();

export const PostOnboardingRequestSchema = z
  .object({
    name: z.string().regex(/\S/, "Missing or invalid agent name"),
    bio: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    style: OnboardingStyleSchema.optional(),
    adjectives: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    postExamples: z.array(z.string()).optional(),
    messageExamples: z.array(MessageExamplesItemSchema).optional(),
    avatarIndex: z.number().optional(),
    presetId: z.string().optional(),
    language: z.string().optional(),
    theme: OnboardingThemeSchema.optional(),
    sandboxMode: z.string().optional(),
    githubToken: z.string().optional(),
    telegramToken: z.string().optional(),
    discordToken: z.string().optional(),
    whatsappSessionPath: z.string().optional(),
    twilioAccountSid: z.string().optional(),
    twilioAuthToken: z.string().optional(),
    twilioPhoneNumber: z.string().optional(),
    blooioApiKey: z.string().optional(),
    blooioPhoneNumber: z.string().optional(),
    inventoryProviders: z.array(InventoryProviderEntrySchema).optional(),
    // Structured sections — handed to dedicated normalization helpers,
    // schema validates only that they are objects.
    deploymentTarget: z.record(z.string(), z.unknown()).optional(),
    linkedAccounts: z.record(z.string(), z.unknown()).optional(),
    serviceRouting: z.record(z.string(), z.unknown()).optional(),
    credentialInputs: z.record(z.string(), z.unknown()).optional(),
    connectors: z.record(z.string(), z.unknown()).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
  })
  // Voice preset fields are read directly off the raw body by
  // `applyOnboardingVoicePreset` — pass them through without enumerating.
  .passthrough()
  .superRefine((value, ctx) => {
    for (const key of ONBOARDING_LEGACY_FIELD_KEYS) {
      if (Object.hasOwn(value, key)) {
        ctx.addIssue({
          code: "custom",
          message:
            "legacy onboarding payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs",
        });
        return;
      }
    }
  })
  .transform((value) => ({
    ...value,
    name: value.name.trim(),
  }));

export type PostOnboardingRequest = z.infer<typeof PostOnboardingRequestSchema>;
export type OnboardingTheme = z.infer<typeof OnboardingThemeSchema>;
export type OnboardingStyle = z.infer<typeof OnboardingStyleSchema>;
export type InventoryProviderEntry = z.infer<
  typeof InventoryProviderEntrySchema
>;
