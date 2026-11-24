// spec/cloud/deployment.md, "Story: Configure a deployment from one reviewed profile"
import { Schema, SchemaGetter } from "effect";
import { maxTokensPerSide } from "../../gen/cloud__services__models.ts";

const pattern = (regex: RegExp) => Schema.String.check(Schema.isPattern(regex));
const bounded = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
function text(maximum: number) {
  const wire = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), Schema.isPattern(/^[^\p{Cc}\p{Cf}]*\S[^\p{Cc}\p{Cf}]*$/u));
  const words = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,32}(?: [A-Za-z0-9_-]{1,16})?$/), Schema.isMaxLength(maximum));
  const domain = Schema.declare(Schema.is(wire), {
    toCodecArbitrary: () => Schema.link<string>()(words, {
      decode: SchemaGetter.transform((value) => value),
      encode: SchemaGetter.forbiddenEncoding,
    }),
  });
  return Schema.decodeTo(domain)(wire);
}

export const HttpsOrigin = pattern(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
export const FirstPartyOrigin = pattern(/^(?:https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9]\d{0,4})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::[1-9]\d{0,4})?)$/);
export const HttpsUrl = pattern(/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/);
export const ProviderUrl = pattern(/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/);
export const SecretName = pattern(/^[A-Z][A-Z0-9_]{1,63}$/);
export const Digest = pattern(/^[0-9a-f]{64}$/);
export const MailAddress = pattern(/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/);
export const Audience = pattern(/^[A-Za-z0-9._-]{1,128}$/);
export const Identifier = pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const CountryCallingCode = pattern(/^\+[1-9]\d{0,2}$/);

export const Capability = Schema.Literals(["inference", "speech", "maps", "managedGoogle", "billing"]);
export type Capability = typeof Capability.Type;

export const LegalDocument = Schema.Struct({
  title: text(200),
  revision: text(64),
  sections: Schema.NonEmptyArray(Schema.Struct({ title: text(200), paragraphs: Schema.NonEmptyArray(text(4000)) })),
});
export type LegalDocument = typeof LegalDocument.Type;

export const MailDelivery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("https"), url: ProviderUrl, apiKeyEnv: SecretName }),
  Schema.Struct({ kind: Schema.Literal("binding"), binding: SecretName }),
  Schema.Struct({ kind: Schema.Literal("loopback") }),
]);

export const SmsDelivery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("https"), url: ProviderUrl, accountEnv: SecretName, tokenEnv: SecretName, from: pattern(/^\+[1-9]\d{6,14}$/) }),
  Schema.Struct({ kind: Schema.Literal("loopback") }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);

export const GoogleSettings = Schema.Struct({
  clientId: Identifier,
  serverClientId: Identifier,
  clientSecretEnv: SecretName,
  nativeSignIn: Schema.Boolean,
  accountsUrl: ProviderUrl,
  tokenUrl: ProviderUrl,
  revokeUrl: ProviderUrl,
  jwksUrl: ProviderUrl,
  apiUrl: ProviderUrl,
  issuers: Schema.NonEmptyArray(pattern(/^(?:https:\/\/)?accounts\.google\.com$|^https?:\/\/[^\s/?#]+$/)),
});

export const PlanBinding = Schema.Struct({ priceId: pattern(/^price_[A-Za-z0-9]{1,250}$/), productId: pattern(/^prod_[A-Za-z0-9]{1,250}$/) });

export const BillingSettings = Schema.Struct({
  apiUrl: ProviderUrl,
  secretKeyEnv: SecretName,
  webhookSecretEnv: SecretName,
  publishableKey: pattern(/^pk_(?:live|test)_[A-Za-z0-9]{1,250}$/),
  plans: Schema.Struct({ plus_monthly: PlanBinding, pro_monthly: PlanBinding }),
});

export const InferenceSettings = Schema.Struct({
  providers: Schema.NonEmptyArray(Schema.Struct({ id: Identifier, baseUrl: ProviderUrl, apiKeyEnv: SecretName })),
  models: Schema.NonEmptyArray(Schema.Struct({
    id: Identifier, provider: Identifier, upstreamModel: Identifier, vision: Schema.Boolean,
    defaultMaxTokens: Schema.optionalKey(bounded(1, maxTokensPerSide)),
  })),
});

export const SpeechSettings = Schema.Struct({
  provider: Identifier,
  baseUrl: ProviderUrl,
  realtimeUrl: pattern(/^wss?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/),
  apiKeyEnv: SecretName,
  tts: Schema.Struct({
    defaultVoiceId: Identifier,
    defaultModelId: Identifier,
    voiceIds: Schema.NonEmptyArray(Identifier),
    modelIds: Schema.NonEmptyArray(Identifier),
    microsPerCharacter: bounded(0, 1_000_000),
  }),
  stt: Schema.Struct({ languageCodes: Schema.Array(pattern(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)), microsPerSecond: bounded(0, 1_000_000) }),
});

const legacyGoogleMapsOrigin = "https://maps.googleapis.com";
const publicGoogleMapsTemplate = "https://{host}.googleapis.com";
const GoogleMapsTemplate = pattern(/^https?:\/\/(?:[^\s/?#{}]*\{host\}[^\s/?#{}]*(?:\/[^\s?#{}]*)?|[^\s/?#{}]+\/[^\s?#{}]*\{host\}[^\s?#{}]*)$/);
const GoogleMapsWireUrl = Schema.Union([GoogleMapsTemplate, Schema.Literal(legacyGoogleMapsOrigin)]);
const GoogleMapsBaseUrl = GoogleMapsWireUrl.pipe(
  Schema.decodeTo<typeof GoogleMapsTemplate, typeof GoogleMapsWireUrl>(GoogleMapsTemplate, {
    decode: SchemaGetter.transform((baseUrl) => baseUrl === legacyGoogleMapsOrigin ? publicGoogleMapsTemplate : baseUrl),
    encode: SchemaGetter.transform((baseUrl) => baseUrl),
  }),
);

export const MapsSettings = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("google"), baseUrl: GoogleMapsBaseUrl, apiKeyEnv: SecretName, coverage: text(64), datasetRevision: text(64) }),
  Schema.Struct({ provider: Schema.Literal("osm"), baseUrl: ProviderUrl, coverage: text(64), datasetRevision: text(64) }),
  Schema.Struct({ provider: Schema.Literal("none") }),
]);

export const EntitlementKey = Schema.Struct({
  kid: Identifier,
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: pattern(/^[A-Za-z0-9_-]{43}$/),
  y: pattern(/^[A-Za-z0-9_-]{43}$/),
});

export const EntitlementSettings = Schema.Struct({
  keyId: Identifier,
  signingKeyEnv: SecretName,
  publicKeys: Schema.NonEmptyArray(EntitlementKey).check(Schema.isMaxLength(16)),
});

export const SealingSettings = Schema.Struct({
  currentKeyId: Identifier,
  keys: Schema.NonEmptyArray(Schema.Struct({ keyId: Identifier, env: SecretName })),
});

export const EnvironmentProfile = Schema.Struct({
  name: text(80),
  api: HttpsOrigin,
  web: HttpsOrigin,
  entitlementAudience: Audience,
  mailSender: MailAddress,
  databaseIdentity: Digest,
  firstPartyOrigins: Schema.Array(FirstPartyOrigin).check(Schema.isUnique()),
  capabilities: Schema.Array(Capability).check(Schema.isUnique()),
  documents: Schema.Struct({ terms: LegalDocument, privacy: LegalDocument }),
  signIn: Schema.Struct({ smsCountries: Schema.Array(CountryCallingCode).check(Schema.isUnique()), smsHourlyBudget: bounded(0, 1_000_000) }),
  mail: MailDelivery,
  sms: SmsDelivery,
  digestKeyEnv: SecretName,
  sealing: SealingSettings,
  entitlement: EntitlementSettings,
  google: Schema.optionalKey(GoogleSettings),
  billing: Schema.optionalKey(BillingSettings),
  inference: Schema.optionalKey(InferenceSettings),
  speech: Schema.optionalKey(SpeechSettings),
  maps: Schema.optionalKey(MapsSettings),
});
export type EnvironmentProfile = typeof EnvironmentProfile.Type;

export const CloudProfile = Schema.Struct({
  version: Schema.Literal(1),
  name: text(80),
  environments: Schema.Struct({ production: EnvironmentProfile, staging: EnvironmentProfile }),
});
export type CloudProfile = typeof CloudProfile.Type;

export const CloudEnvironment = Schema.Literals(["production", "staging"]);
export type CloudEnvironment = typeof CloudEnvironment.Type;
