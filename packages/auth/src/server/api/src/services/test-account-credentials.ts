import { createHmac } from "node:crypto";
import { isDevSecretAllowed } from "../../../auth/src/index.ts";
import type { TenantTestAccountConfig } from "../../../shared/src/index.ts";

const TEST_ACCOUNT_EMAIL_DOMAIN = "steward.test";
const OTP_HASH_PREFIX = "stwd_testotp_v1:";
type TenantTestAccountConfigWithHash = TenantTestAccountConfig & {
  otpHash?: string;
};

function env(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {}
  );
}

function otpPepper(): string {
  const currentEnv = env();
  const pepper =
    currentEnv.STEWARD_TEST_ACCOUNT_OTP_PEPPER ??
    currentEnv.STEWARD_MASTER_PASSWORD;
  if (!pepper) {
    // Insecure dev fallback must be explicitly opted into; never in production.
    if (!isDevSecretAllowed(currentEnv.NODE_ENV)) {
      throw new Error(
        "STEWARD_TEST_ACCOUNT_OTP_PEPPER or STEWARD_MASTER_PASSWORD is required. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev pepper.",
      );
    }
    return "dev-secret";
  }
  return pepper;
}

function testCredentialDigits(length: number): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

export function hashTestAccountOtp(otp: string): string {
  const digest = createHmac("sha256", otpPepper())
    .update(otp.trim())
    .digest("hex");
  return `${OTP_HASH_PREFIX}${digest}`;
}

export function testAccountOtpMatches(
  actual: string | undefined,
  config: Pick<TenantTestAccountConfigWithHash, "otp" | "otpHash">,
): boolean {
  if (!actual) return false;
  if (config.otpHash?.startsWith(OTP_HASH_PREFIX)) {
    return hashTestAccountOtp(actual) === config.otpHash;
  }
  return (
    typeof config.otp === "string" &&
    hashTestAccountOtp(actual) === hashTestAccountOtp(config.otp)
  );
}

export function createTenantTestAccountConfig(): {
  testAccount: Required<
    Pick<
      TenantTestAccountConfig,
      "enabled" | "email" | "phone" | "createdAt" | "updatedAt"
    >
  > &
    Required<Pick<TenantTestAccountConfigWithHash, "otpHash">>;
  otp: string;
} {
  const now = new Date().toISOString();
  const otp = testCredentialDigits(6);
  return {
    testAccount: {
      enabled: true,
      email: `test-${testCredentialDigits(6)}@${TEST_ACCOUNT_EMAIL_DOMAIN}`,
      phone: `+1555555${testCredentialDigits(4)}`,
      otpHash: hashTestAccountOtp(otp),
      createdAt: now,
      updatedAt: now,
    } satisfies TenantTestAccountConfigWithHash,
    otp,
  };
}

export function publicTestAccount(
  config: TenantTestAccountConfig | undefined,
  otp?: string,
): TenantTestAccountConfig {
  if (!config?.enabled) return { enabled: false };
  return {
    enabled: true,
    email: config.email,
    phone: config.phone,
    otp,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export function redactedTestAccount(
  config: TenantTestAccountConfig | undefined,
): TenantTestAccountConfig {
  const publicConfig = publicTestAccount(config);
  if (!publicConfig.enabled) return publicConfig;
  const { otp: _otp, ...redacted } = publicConfig;
  return redacted;
}
