import type {
  TenantAuthAbuseConfig,
  TenantCaptchaAction,
  TenantCaptchaProvider,
} from "../../../shared/src/index.ts";

const CAPTCHA_PROVIDERS = new Set<TenantCaptchaProvider>([
  "turnstile",
  "hcaptcha",
]);
const CAPTCHA_ACTIONS = new Set<TenantCaptchaAction>(["email_otp", "sms_otp"]);
const LOGIN_METHODS = new Set([
  "passkey",
  "email",
  "sms",
  "whatsapp",
  "totp",
  "siwe",
  "siws",
  "telegram",
  "farcaster",
] as const);
type ScalarLoginMethod =
  typeof LOGIN_METHODS extends Set<infer Method> ? Method : never;
const CAPTCHA_SECRET_ENV_RE =
  /^STEWARD_(?=.*(?:CAPTCHA|TURNSTILE|HCAPTCHA))(?=.*SECRET)[A-Z0-9_]{1,96}$/;
const MFA_REQUIRE_FOR = new Set([
  "vaultSigning",
  "keyImport",
  "keyExport",
  "recoveryCodes",
  "tenantAdmin",
] as const);
const MFA_DISABLE_FOR = new Set(["keyImport", "keyExport"] as const);
const MFA_MAX_AGE_FOR = MFA_REQUIRE_FOR;
const MIN_MFA_MAX_AGE_SECONDS = 30;
const MAX_MFA_MAX_AGE_SECONDS = 60 * 60;

type TenantMfaPolicyConfig = {
  maxAgeSeconds?: number;
  maxAgeFor?: {
    vaultSigning?: number;
    keyImport?: number;
    keyExport?: number;
    recoveryCodes?: number;
    tenantAdmin?: number;
  };
  requireFor?: {
    vaultSigning?: boolean;
    keyImport?: boolean;
    keyExport?: boolean;
    recoveryCodes?: boolean;
    tenantAdmin?: boolean;
  };
  disableFor?: {
    keyImport?: boolean;
    keyExport?: boolean;
  };
  allowDelegatedSignerAutomation?: boolean;
  allowKeyQuorumAutomation?: boolean;
};

type TenantAuthAbuseConfigWithMfa = TenantAuthAbuseConfig & {
  mfa?: TenantMfaPolicyConfig;
};

const DEFAULT_DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCaptchaProvider(value: unknown): value is TenantCaptchaProvider {
  return (
    typeof value === "string" &&
    CAPTCHA_PROVIDERS.has(value as TenantCaptchaProvider)
  );
}

function isCaptchaAction(value: unknown): value is TenantCaptchaAction {
  return (
    typeof value === "string" &&
    CAPTCHA_ACTIONS.has(value as TenantCaptchaAction)
  );
}

function normalizeCaptchaSecretEnv(
  value: unknown,
): string | undefined | string {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return "captcha.secretKeyEnv must be a string";
  const envName = value.trim();
  if (!CAPTCHA_SECRET_ENV_RE.test(envName)) {
    return "captcha.secretKeyEnv must be a STEWARD_* CAPTCHA secret environment variable";
  }
  return envName;
}

function normalizeDomainList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const domains = value
    .map((entry) =>
      typeof entry === "string" ? entry.trim().toLowerCase() : "",
    )
    .filter(Boolean);
  if (domains.length > 500) return `${field} can include at most 500 domains`;
  if (!domains.every((domain) => /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(domain))) {
    return `${field} contains an invalid domain`;
  }
  return [...new Set(domains)];
}

function normalizeEmailList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const emails = value
    .map((entry) =>
      typeof entry === "string" ? entry.trim().toLowerCase() : "",
    )
    .filter(Boolean);
  if (emails.length > 5000) return `${field} can include at most 5000 emails`;
  if (!emails.every((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    return `${field} contains an invalid email`;
  }
  return [...new Set(emails)];
}

function normalizeWalletList(value: unknown, field: string): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const wallets = value
    .map((entry) =>
      typeof entry === "string" ? entry.trim().toLowerCase() : "",
    )
    .filter(Boolean);
  if (wallets.length > 5000) return `${field} can include at most 5000 wallets`;
  if (
    !wallets.every(
      (wallet) =>
        /^0x[a-f0-9]{40}$/.test(wallet) ||
        /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet),
    )
  ) {
    return `${field} contains an invalid wallet`;
  }
  return [...new Set(wallets)];
}

function normalizeCountryCodeList(
  value: unknown,
  field: string,
): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const codes = value
    .map((entry) =>
      typeof entry === "string" ? entry.trim().replace(/^\+/, "") : "",
    )
    .filter(Boolean);
  if (codes.length > 300)
    return `${field} can include at most 300 country codes`;
  if (!codes.every((code) => /^[1-9]\d{0,3}$/.test(code))) {
    return `${field} contains an invalid country code`;
  }
  return [...new Set(codes)];
}

function normalizePhoneNumberList(
  value: unknown,
  field: string,
): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const phones = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (phones.length > 5000)
    return `${field} can include at most 5000 phone numbers`;
  if (!phones.every((phone) => /^\+[1-9]\d{1,14}$/.test(phone))) {
    return `${field} must contain E.164 phone numbers`;
  }
  return [...new Set(phones)];
}

function normalizeBooleanRecord(
  value: unknown,
  field: string,
): Record<string, boolean> | string {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return `${field} must be an object`;
  const entries = Object.entries(value);
  if (entries.length > 50) return `${field} can include at most 50 entries`;
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of entries) {
    const normalizedKey = key.trim().toLowerCase();
    if (!/^[a-z0-9_.:-]{1,64}$/.test(normalizedKey)) {
      return `${field} contains an invalid provider id`;
    }
    if (typeof enabled !== "boolean")
      return `${field}.${key} must be a boolean`;
    result[normalizedKey] = enabled;
  }
  return result;
}

function normalizeMfaPolicy(value: unknown): TenantMfaPolicyConfig | string {
  if (!isPlainObject(value)) return "mfa policy config must be an object";
  const policy: TenantMfaPolicyConfig = {};

  if (value.maxAgeSeconds !== undefined) {
    const maxAgeSeconds = Number(value.maxAgeSeconds);
    if (
      !Number.isSafeInteger(maxAgeSeconds) ||
      maxAgeSeconds < MIN_MFA_MAX_AGE_SECONDS ||
      maxAgeSeconds > MAX_MFA_MAX_AGE_SECONDS
    ) {
      return `mfa.maxAgeSeconds must be an integer between ${MIN_MFA_MAX_AGE_SECONDS} and ${MAX_MFA_MAX_AGE_SECONDS}`;
    }
    policy.maxAgeSeconds = maxAgeSeconds;
  }

  if (value.maxAgeFor !== undefined) {
    if (!isPlainObject(value.maxAgeFor))
      return "mfa.maxAgeFor must be an object";
    const maxAgeFor: NonNullable<TenantMfaPolicyConfig["maxAgeFor"]> = {};
    for (const key of MFA_MAX_AGE_FOR) {
      const rawMaxAgeSeconds = value.maxAgeFor[key];
      if (rawMaxAgeSeconds !== undefined) {
        const maxAgeSeconds = Number(rawMaxAgeSeconds);
        if (
          !Number.isSafeInteger(maxAgeSeconds) ||
          maxAgeSeconds < MIN_MFA_MAX_AGE_SECONDS ||
          maxAgeSeconds > MAX_MFA_MAX_AGE_SECONDS
        ) {
          return `mfa.maxAgeFor.${key} must be an integer between ${MIN_MFA_MAX_AGE_SECONDS} and ${MAX_MFA_MAX_AGE_SECONDS}`;
        }
        maxAgeFor[key] = maxAgeSeconds;
      }
    }
    policy.maxAgeFor = maxAgeFor;
  }

  if (value.requireFor !== undefined) {
    if (!isPlainObject(value.requireFor))
      return "mfa.requireFor must be an object";
    const requireFor: NonNullable<TenantMfaPolicyConfig["requireFor"]> = {};
    for (const key of MFA_REQUIRE_FOR) {
      const enabled = value.requireFor[key];
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean")
          return `mfa.requireFor.${key} must be a boolean`;
        requireFor[key] = enabled;
      }
    }
    policy.requireFor = requireFor;
  }

  if (value.disableFor !== undefined) {
    if (!isPlainObject(value.disableFor))
      return "mfa.disableFor must be an object";
    const disableFor: NonNullable<TenantMfaPolicyConfig["disableFor"]> = {};
    for (const key of MFA_DISABLE_FOR) {
      const disabled = value.disableFor[key];
      if (disabled !== undefined) {
        if (typeof disabled !== "boolean")
          return `mfa.disableFor.${key} must be a boolean`;
        disableFor[key] = disabled;
      }
    }
    policy.disableFor = disableFor;
  }

  if (value.allowDelegatedSignerAutomation !== undefined) {
    if (typeof value.allowDelegatedSignerAutomation !== "boolean") {
      return "mfa.allowDelegatedSignerAutomation must be a boolean";
    }
    policy.allowDelegatedSignerAutomation =
      value.allowDelegatedSignerAutomation;
  }

  if (value.allowKeyQuorumAutomation !== undefined) {
    if (typeof value.allowKeyQuorumAutomation !== "boolean") {
      return "mfa.allowKeyQuorumAutomation must be a boolean";
    }
    policy.allowKeyQuorumAutomation = value.allowKeyQuorumAutomation;
  }

  return policy;
}

export function normalizeAuthAbuseConfig(
  value: unknown,
): TenantAuthAbuseConfigWithMfa | string {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return "authAbuseConfig must be an object";

  const config: TenantAuthAbuseConfigWithMfa = {};

  if (value.loginMethods !== undefined) {
    if (!isPlainObject(value.loginMethods))
      return "loginMethods config must be an object";
    const loginMethods: NonNullable<TenantAuthAbuseConfig["loginMethods"]> = {};
    for (const method of LOGIN_METHODS) {
      const enabled = value.loginMethods[method];
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean")
          return `loginMethods.${method} must be a boolean`;
        loginMethods[method as ScalarLoginMethod] = enabled;
      }
    }
    const oauth = normalizeBooleanRecord(
      value.loginMethods.oauth,
      "loginMethods.oauth",
    );
    if (typeof oauth === "string") return oauth;
    const oidc = normalizeBooleanRecord(
      value.loginMethods.oidc,
      "loginMethods.oidc",
    );
    if (typeof oidc === "string") return oidc;
    if (Object.keys(oauth).length > 0) loginMethods.oauth = oauth;
    if (Object.keys(oidc).length > 0) loginMethods.oidc = oidc;
    config.loginMethods = loginMethods;
  }

  if (value.captcha !== undefined) {
    if (!isPlainObject(value.captcha))
      return "captcha config must be an object";
    const provider = value.captcha.provider;
    if (provider !== undefined && !isCaptchaProvider(provider)) {
      return "captcha provider must be turnstile or hcaptcha";
    }
    const requiredForRaw = value.captcha.requiredFor;
    let requiredFor: TenantCaptchaAction[] | undefined;
    if (requiredForRaw !== undefined) {
      if (!Array.isArray(requiredForRaw))
        return "captcha.requiredFor must be an array";
      if (
        !requiredForRaw.every((action): action is TenantCaptchaAction =>
          isCaptchaAction(action),
        )
      ) {
        return "captcha.requiredFor contains an unsupported action";
      }
      requiredFor = [...new Set(requiredForRaw)];
    }
    const secretKeyEnv = normalizeCaptchaSecretEnv(value.captcha.secretKeyEnv);
    if (
      typeof secretKeyEnv === "string" &&
      secretKeyEnv.startsWith("captcha.")
    ) {
      return secretKeyEnv;
    }

    config.captcha = {
      enabled: value.captcha.enabled === true,
      provider: (provider as TenantCaptchaProvider | undefined) ?? "turnstile",
      siteKey:
        typeof value.captcha.siteKey === "string"
          ? value.captcha.siteKey.trim()
          : undefined,
      secretKeyEnv,
      requiredFor,
    };
  }

  if (value.email !== undefined) {
    if (!isPlainObject(value.email))
      return "email abuse config must be an object";
    const allowedEmails = normalizeEmailList(
      value.email.allowedEmails,
      "email.allowedEmails",
    );
    if (typeof allowedEmails === "string") return allowedEmails;
    const blockedEmails = normalizeEmailList(
      value.email.blockedEmails,
      "email.blockedEmails",
    );
    if (typeof blockedEmails === "string") return blockedEmails;
    const allowedDomains = normalizeDomainList(
      value.email.allowedDomains,
      "email.allowedDomains",
    );
    if (typeof allowedDomains === "string") return allowedDomains;
    const blockedDomains = normalizeDomainList(
      value.email.blockedDomains,
      "email.blockedDomains",
    );
    if (typeof blockedDomains === "string") return blockedDomains;
    config.email = {
      blockDisposable: value.email.blockDisposable === true,
      blockPlusAliases: value.email.blockPlusAliases === true,
      allowedEmails,
      blockedEmails,
      allowedDomains,
      blockedDomains,
    };
  }

  if (value.wallet !== undefined) {
    if (!isPlainObject(value.wallet))
      return "wallet abuse config must be an object";
    const allowedWallets = normalizeWalletList(
      value.wallet.allowedWallets,
      "wallet.allowedWallets",
    );
    if (typeof allowedWallets === "string") return allowedWallets;
    const blockedWallets = normalizeWalletList(
      value.wallet.blockedWallets,
      "wallet.blockedWallets",
    );
    if (typeof blockedWallets === "string") return blockedWallets;
    if (
      value.wallet.restrictToOneThirdPartyWallet !== undefined &&
      typeof value.wallet.restrictToOneThirdPartyWallet !== "boolean"
    ) {
      return "wallet.restrictToOneThirdPartyWallet must be a boolean";
    }
    config.wallet = {
      allowedWallets,
      blockedWallets,
      restrictToOneThirdPartyWallet:
        value.wallet.restrictToOneThirdPartyWallet === true,
    };
  }

  if (value.phone !== undefined) {
    if (!isPlainObject(value.phone))
      return "phone abuse config must be an object";
    const allowedPhoneNumbers = normalizePhoneNumberList(
      value.phone.allowedPhoneNumbers,
      "phone.allowedPhoneNumbers",
    );
    if (typeof allowedPhoneNumbers === "string") return allowedPhoneNumbers;
    const blockedPhoneNumbers = normalizePhoneNumberList(
      value.phone.blockedPhoneNumbers,
      "phone.blockedPhoneNumbers",
    );
    if (typeof blockedPhoneNumbers === "string") return blockedPhoneNumbers;
    const allowedCountryCodes = normalizeCountryCodeList(
      value.phone.allowedCountryCodes,
      "phone.allowedCountryCodes",
    );
    if (typeof allowedCountryCodes === "string") return allowedCountryCodes;
    const blockedCountryCodes = normalizeCountryCodeList(
      value.phone.blockedCountryCodes,
      "phone.blockedCountryCodes",
    );
    if (typeof blockedCountryCodes === "string") return blockedCountryCodes;
    config.phone = {
      blockVoip: value.phone.blockVoip === true,
      allowedPhoneNumbers,
      blockedPhoneNumbers,
      allowedCountryCodes,
      blockedCountryCodes,
    };
  }

  if (value.mfa !== undefined) {
    const mfa = normalizeMfaPolicy(value.mfa);
    if (typeof mfa === "string") return mfa;
    config.mfa = mfa;
  }

  return config;
}

export function publicAuthAbuseConfig(
  config: TenantAuthAbuseConfig,
): TenantAuthAbuseConfig {
  return {
    ...config,
    captcha: config.captcha
      ? {
          enabled: config.captcha.enabled,
          provider: config.captcha.provider,
          siteKey: config.captcha.siteKey,
          requiredFor: config.captcha.requiredFor,
        }
      : undefined,
  };
}

export function validateEmailAbusePolicy(
  email: string,
  config: TenantAuthAbuseConfig,
): string | null {
  const [localPart, domainPart] = email.toLowerCase().split("@");
  if (!localPart || !domainPart) return "email is invalid";
  const domain = domainPart.trim();
  const emailConfig = config.email;
  if (!emailConfig) return null;

  if (emailConfig.blockedEmails?.includes(email.toLowerCase())) {
    return "email is blocked";
  }
  if (
    emailConfig.allowedEmails?.length &&
    !emailConfig.allowedEmails.includes(email.toLowerCase())
  ) {
    return "email is not allowed";
  }
  if (emailConfig.blockPlusAliases && localPart.includes("+")) {
    return "plus-addressed emails are not allowed";
  }
  if (
    emailConfig.allowedDomains?.length &&
    !emailConfig.allowedDomains.includes(domain)
  ) {
    return "email domain is not allowed";
  }
  if (emailConfig.blockedDomains?.includes(domain)) {
    return "email domain is blocked";
  }
  if (emailConfig.blockDisposable) {
    const envDomains = new Set(
      (process.env.STEWARD_DISPOSABLE_EMAIL_DOMAINS ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
    if (DEFAULT_DISPOSABLE_DOMAINS.has(domain) || envDomains.has(domain)) {
      return "disposable email domains are not allowed";
    }
  }
  return null;
}

export function validateWalletAbusePolicy(
  walletAddress: string,
  chain: "ethereum" | "solana",
  config: TenantAuthAbuseConfig,
): string | null {
  const walletConfig = config.wallet;
  if (!walletConfig) return null;
  const normalized =
    chain === "solana"
      ? `solana:${walletAddress}`.toLowerCase()
      : walletAddress.toLowerCase();
  if (walletConfig.blockedWallets?.includes(normalized)) {
    return "wallet is blocked";
  }
  if (
    walletConfig.allowedWallets?.length &&
    !walletConfig.allowedWallets.includes(normalized)
  ) {
    return "wallet is not allowed";
  }
  return null;
}

function matchesCountryCode(phone: string, countryCodes: string[]): boolean {
  const digits = phone.replace(/^\+/, "");
  return countryCodes.some((code) => digits.startsWith(code));
}

export function validatePhoneAbusePolicy(
  phone: string,
  config: TenantAuthAbuseConfig,
): string | null {
  const phoneConfig = config.phone;
  if (!phoneConfig) return null;
  if (phoneConfig.blockedPhoneNumbers?.includes(phone)) {
    return "phone number is blocked";
  }
  if (
    phoneConfig.allowedPhoneNumbers?.length &&
    !phoneConfig.allowedPhoneNumbers.includes(phone)
  ) {
    return "phone number is not allowed";
  }
  if (
    phoneConfig.allowedCountryCodes?.length &&
    !matchesCountryCode(phone, phoneConfig.allowedCountryCodes)
  ) {
    return "phone country code is not allowed";
  }
  if (
    phoneConfig.blockedCountryCodes?.length &&
    matchesCountryCode(phone, phoneConfig.blockedCountryCodes)
  ) {
    return "phone country code is blocked";
  }
  if (phoneConfig.blockVoip) {
    const blockedPrefixes = (process.env.STEWARD_VOIP_PHONE_PREFIXES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (
      blockedPrefixes.length &&
      blockedPrefixes.some((prefix) => phone.startsWith(prefix))
    ) {
      return "VOIP phone numbers are not allowed";
    }
  }
  return null;
}

export async function verifyCaptchaToken(
  config: TenantAuthAbuseConfig,
  action: TenantCaptchaAction,
  token: string | undefined,
  remoteIp?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const captcha = config.captcha;
  if (!captcha?.enabled) return { ok: true };
  const requiredFor = captcha.requiredFor ?? ["email_otp", "sms_otp"];
  if (!requiredFor.includes(action)) return { ok: true };
  if (!token || typeof token !== "string") {
    return { ok: false, status: 400, error: "captchaToken is required" };
  }

  const provider = captcha.provider ?? "turnstile";
  const secretEnv =
    captcha.secretKeyEnv ||
    (provider === "hcaptcha"
      ? "STEWARD_HCAPTCHA_SECRET_KEY"
      : "STEWARD_TURNSTILE_SECRET_KEY");
  const safeSecretEnv = normalizeCaptchaSecretEnv(secretEnv);
  if (
    typeof safeSecretEnv === "string" &&
    safeSecretEnv.startsWith("captcha.")
  ) {
    return {
      ok: false,
      status: 503,
      error: "CAPTCHA provider is not configured",
    };
  }
  const secret = process.env[secretEnv]?.trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "CAPTCHA provider is not configured",
    };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const endpoint =
    provider === "hcaptcha"
      ? "https://hcaptcha.com/siteverify"
      : "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    return { ok: false, status: 502, error: "CAPTCHA verification failed" };
  }
  const payload = (await response.json()) as { success?: boolean };
  return payload.success === true
    ? { ok: true }
    : { ok: false, status: 400, error: "CAPTCHA verification failed" };
}
