// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"; spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";
import type { FailureCode, GoogleReport, Verdict } from "../../../gen/os__signIn__flow.ts";
import type { GoogleMode, ServiceOutcome } from "../../../gen/os__signIn__readiness.ts";

export type { FailureCode, GoogleMode, GoogleReport, ServiceOutcome };

export type SignInRequest = number & Brand.Brand<"SignInRequest">;
export type SignInAttempt = number & Brand.Brand<"SignInAttempt">;
export type CredentialId = string & Brand.Brand<"CredentialId">;
export type SignInCode = string & Brand.Brand<"SignInCode">;
export type EnvironmentName = string & Brand.Brand<"EnvironmentName">;

export type SecondFactor = "totp" | "sms";

export type SignInStart = { method: "email"; email: string } | { method: "sms"; phone: string } | { method: "google" };

export type SignInOptions = SignInStart & { environment: EnvironmentName };

export interface AttemptOptions {
  attempt: SignInAttempt;
}

export interface VerifyOptions extends AttemptOptions {
  code: SignInCode;
  factor?: SecondFactor;
}

export interface EnvironmentOptions {
  environment: EnvironmentName;
}

export interface ReadinessOptions extends EnvironmentOptions {
  retry?: boolean;
}

type VerdictOf<Tag extends Verdict["tag"]> = Omit<Extract<Verdict, { tag: Tag }>, "tag"> & { kind: Tag };

export type SignInVerdict =
  | (VerdictOf<"CodeOnItsWay"> & { expiresAt: number; resendAt: number })
  | (VerdictOf<"FactorAsked"> & { factors: readonly SecondFactor[]; expiresAt: number })
  | (Omit<VerdictOf<"SignedInAs">, "credentialId"> & { credentialId: CredentialId })
  | VerdictOf<"AccountConfirmed">
  | VerdictOf<"TryAgain">
  | VerdictOf<"Ended">;

export interface SignInReceipt {
  request: SignInRequest;
  attempt: SignInAttempt;
  verdict: SignInVerdict;
}

export type SignInAccount =
  | { kind: "signedOut" }
  | { kind: "signedIn"; userId: string; organizationId: string; credentialId: CredentialId; keyExpiresAt: number };

export interface SignInReadiness {
  environment: EnvironmentName;
  methodsKnown: boolean;
  email: boolean;
  sms: boolean;
  google: boolean;
  googleMode: GoogleMode;
}

export interface SignInStatus {
  readiness: SignInReadiness;
  account: SignInAccount;
}

export interface DocumentSection {
  title: string;
  paragraphs: readonly string[];
}

export interface LegalDocument {
  title: string;
  revision: string;
  sections: readonly DocumentSection[];
}

export interface ServiceTerms {
  name: string;
  terms: LegalDocument;
  privacy: LegalDocument;
}

export type ServiceDocument =
  | { kind: Extract<ServiceOutcome, "ServiceShown">; environment: EnvironmentName; service: ServiceTerms }
  | { kind: Exclude<ServiceOutcome, "ServiceShown">; environment: EnvironmentName };

export interface SignInEvents {
  signInSettled: SignInReceipt;
  signInReadinessChanged: SignInReadiness;
}

export interface ElizaSignInPlugin {
  startEmail(options: { environment: EnvironmentName; email: string }): Promise<unknown>;
  startPhone(options: { environment: EnvironmentName; phone: string }): Promise<unknown>;
  startGoogle(options: EnvironmentOptions): Promise<unknown>;
  reauthenticate(options: SignInOptions): Promise<unknown>;
  resend(options: AttemptOptions): Promise<unknown>;
  verify(options: { attempt: SignInAttempt; code: SignInCode; method?: SecondFactor }): Promise<unknown>;
  sendFactorCode(options: AttemptOptions): Promise<unknown>;
  cancel(options: AttemptOptions): Promise<unknown>;
  signOut(options: EnvironmentOptions): Promise<unknown>;
  status(options: ReadinessOptions): Promise<unknown>;
  serviceInfo(options: EnvironmentOptions): Promise<unknown>;
  addListener(eventName: keyof SignInEvents, listener: (event: unknown) => void): Promise<PluginListenerHandle>;
}

export interface SignInClient {
  start(options: SignInOptions): Promise<SignInReceipt>;
  reauthenticate(options: SignInOptions): Promise<SignInReceipt>;
  resend(options: AttemptOptions): Promise<SignInReceipt>;
  verify(options: VerifyOptions): Promise<SignInReceipt>;
  sendFactorCode(options: AttemptOptions): Promise<SignInAttempt>;
  cancel(options: AttemptOptions): Promise<boolean>;
  signOut(options: EnvironmentOptions): Promise<SignInAccount>;
  status(options: ReadinessOptions): Promise<SignInStatus>;
  readiness(options: ReadinessOptions): Promise<SignInReadiness>;
  serviceDocument(options: EnvironmentOptions): Promise<ServiceDocument>;
  addListener<Name extends keyof SignInEvents>(eventName: Name, listener: (event: SignInEvents[Name]) => void): Promise<PluginListenerHandle>;
}
