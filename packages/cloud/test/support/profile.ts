// spec/cloud/deployment.md, "Story: Configure a deployment from one reviewed profile"
import { randomBytes } from "node:crypto";

const document = (title: string) => ({
  title,
  revision: "2026-11-01",
  sections: [{ title: "Scope", paragraphs: [`${title} of the test deployment.`] }],
});

export const testDatabaseIdentity = "a".repeat(64);

export const catalogPrices = [
  { priceId: "price_plus", productId: "prod_plus", unitAmount: 3_000 },
  { priceId: "price_pro", productId: "prod_pro", unitAmount: 10_000 },
] as const;

export const secrets: Readonly<Record<string, string>> = {
  CLOUD_DIGEST_KEY: randomBytes(32).toString("base64"),
  CLOUD_SEALING_KEY: randomBytes(32).toString("base64"),
  CLOUD_ENTITLEMENT_KEY: "test-entitlement-signing-key",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  GOOGLE_CLIENT_SECRET: "google-secret",
  LLM_API_KEY: "llm-key",
  SPEECH_API_KEY: "speech-key",
  MAPS_API_KEY: "maps-key",
};

export function environmentProfile(fakeUrl: string, api: string, web: string) {
  return {
    api,
    web,
    entitlementAudience: "cloud-subscription",
    mailSender: "sign-in@mail.example.com",
    databaseIdentity: testDatabaseIdentity,
    firstPartyOrigins: [web, "https://localhost"],
    capabilities: ["inference", "speech", "maps", "managedGoogle", "billing"],
    documents: { terms: document("Terms"), privacy: document("Privacy") },
    signIn: { smsCountries: ["+1"], smsHourlyBudget: 100 },
    mail: { kind: "loopback" },
    sms: { kind: "loopback" },
    digestKeyEnv: "CLOUD_DIGEST_KEY",
    sealing: { currentKeyId: "seal-1", keys: [{ keyId: "seal-1", env: "CLOUD_SEALING_KEY" }] },
    entitlement: {
      keyId: "entitlement-1",
      signingKeyEnv: "CLOUD_ENTITLEMENT_KEY",
      publicKeys: [{ kid: "entitlement-1", kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) }],
    },
    google: {
      clientId: "google-web-client",
      serverClientId: "google-server-client",
      clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      nativeSignIn: true,
      accountsUrl: `${fakeUrl}/google/accounts`,
      tokenUrl: `${fakeUrl}/google/token`,
      revokeUrl: `${fakeUrl}/google/revoke`,
      jwksUrl: `${fakeUrl}/google/jwks`,
      apiUrl: `${fakeUrl}/google/api`,
      issuers: ["https://accounts.google.com"],
    },
    billing: {
      apiUrl: `${fakeUrl}/stripe`,
      secretKeyEnv: "STRIPE_SECRET_KEY",
      webhookSecretEnv: "STRIPE_WEBHOOK_SECRET",
      publishableKey: "pk_test_fake",
      plans: {
        plus_monthly: { priceId: catalogPrices[0].priceId, productId: catalogPrices[0].productId },
        pro_monthly: { priceId: catalogPrices[1].priceId, productId: catalogPrices[1].productId },
      },
    },
    inference: {
      providers: [{ id: "llm", baseUrl: `${fakeUrl}/llm`, apiKeyEnv: "LLM_API_KEY" }],
      models: [{ id: "test-chat", provider: "llm", upstreamModel: "upstream-chat", vision: true }],
    },
    speech: {
      provider: "speech",
      baseUrl: `${fakeUrl}/speech`,
      realtimeUrl: `${fakeUrl.replace("http", "ws")}/speech/realtime`,
      apiKeyEnv: "SPEECH_API_KEY",
      tts: { defaultVoiceId: "voice-1", defaultModelId: "model-1", voiceIds: ["voice-1"], modelIds: ["model-1"], microsPerCharacter: 30 },
      stt: { languageCodes: ["en", "en-US"], microsPerSecond: 100 },
    },
    maps: { provider: "google", baseUrl: `${fakeUrl}/maps`, apiKeyEnv: "MAPS_API_KEY", coverage: "global", datasetRevision: "2026-11" },
  };
}

export function testProfile(fakeUrl: string) {
  return {
    version: 1,
    name: "Test Cloud",
    environments: {
      production: environmentProfile(fakeUrl, "https://api.example.com", "https://www.example.com"),
      staging: environmentProfile(fakeUrl, "https://api.staging.example.com", "https://www.staging.example.com"),
    },
  };
}
