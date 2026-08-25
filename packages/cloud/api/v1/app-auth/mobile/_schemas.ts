/** Request schemas shared by the first-party mobile App Auth routes. */
import { z } from "zod";
import { MOBILE_APP_AUTH_DEVICE_NAME_MAX_LENGTH } from "@/lib/services/mobile-app-auth";

const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MOBILE_APP_AUTH_DEVICE_NAME_MAX_LENGTH)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "Device name contains unsupported control characters",
  });

export const mobileAppAuthClientBindingSchema = z
  .object({
    clientId: z.string().min(1).max(200),
    environment: z.string().min(1).max(50),
    redirectUri: z.string().url().max(2_000),
  })
  .strict();

export const mobileAppAuthPkceBindingSchema =
  mobileAppAuthClientBindingSchema.extend({
    state: z.string().min(1).max(256),
    codeChallenge: z.string().min(1).max(256),
    codeChallengeMethod: z.string().min(1).max(20),
    deviceName: deviceNameSchema.optional(),
  });

export const mobileAppAuthTokenSchema = mobileAppAuthClientBindingSchema.extend(
  {
    grantType: z.literal("authorization_code"),
    code: z.string().min(1).max(256),
    state: z.string().min(1).max(256),
    codeVerifier: z.string().min(1).max(256),
  },
);

export const mobileAppAuthAckSchema = mobileAppAuthClientBindingSchema.extend({
  code: z.string().min(1).max(256),
  state: z.string().min(1).max(256),
  codeVerifier: z.string().min(1).max(256),
  credentialId: z.string().uuid(),
  secret: z.string().min(1).max(512),
});
