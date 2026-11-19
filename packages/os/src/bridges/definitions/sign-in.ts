// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"; spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";
import type { GoogleMode, ServiceOutcome } from "../../../gen/os__signIn__readiness.ts";

export type { GoogleMode, ServiceOutcome };

export type SignInRequestId = string & Brand.Brand<"SignInRequestId">;
export type SignInAttemptId = string & Brand.Brand<"SignInAttemptId">;
export type CredentialId = string & Brand.Brand<"CredentialId">;
export type SignInCode = string & Brand.Brand<"SignInCode">;
export type EnvironmentName = string & Brand.Brand<"EnvironmentName">;

export type SignInFailureCode =
  | "cancelled"
  | "busy"
  | "invalid-request"
  | "invalid-code"
  | "expired"
  | "too-many-attempts"
  | "unavailable"
  | "refused"
  | "google-unavailable"
  | "storage";

export type GoogleOutcome = "connected" | "refused" | "not-requested";

export type SecondFactor = "totp" | "sms";

export type OpenStep = "starting" | "code-sent" | "verifying" | "second-factor" | "exchanging";

export type SignInStart = { method: "email"; email: string } | { method: "sms"; phone: string } | { method: "google" };

export type SignInOptions = SignInStart & { requestId: SignInRequestId; environment: EnvironmentName };

export interface VerifyOptions {
  requestId: SignInRequestId;
  code: SignInCode;
  factor?: SecondFactor;
}

export interface RequestOptions {
  requestId: SignInRequestId;
}

export interface EnvironmentOptions {
  environment: EnvironmentName;
}

export interface ReadinessOptions extends EnvironmentOptions {
  retry?: boolean;
}

export interface SignInReceipt {
  requestId: SignInRequestId;
  attemptId: SignInAttemptId;
  credentialId: CredentialId;
  google: GoogleOutcome;
}

export type SignInSettled =
  | { kind: "signedIn"; receipt: SignInReceipt }
  | { kind: "failed"; requestId: SignInRequestId; attemptId: SignInAttemptId; code: SignInFailureCode };

export type SignInProgress =
  | { kind: "codeSent"; requestId: SignInRequestId; attemptId: SignInAttemptId; expiresAt: number; resendAt: number }
  | { kind: "secondFactor"; requestId: SignInRequestId; attemptId: SignInAttemptId; factors: readonly SecondFactor[]; expiresAt: number }
  | { kind: "signedIn"; receipt: SignInReceipt };

export type SignInRefusal =
  | { kind: "settled"; settled: Extract<SignInSettled, { kind: "failed" }> }
  | { kind: "kept"; requestId: SignInRequestId; step: OpenStep }
  | { kind: "resendLater"; resendAt: number }
  | { kind: "refused" };

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

export interface ServiceTerms {
  name: string;
  terms: string;
  privacy: string;
}

export type ServiceDocument =
  | { kind: Extract<ServiceOutcome, "ServiceShown">; environment: EnvironmentName; service: ServiceTerms }
  | { kind: Exclude<ServiceOutcome, "ServiceShown">; environment: EnvironmentName };

export interface SignInEvents {
  signInSettled: SignInSettled;
  signInReadinessChanged: SignInReadiness;
}

export interface ElizaSignInPlugin {
  startEmail(options: { requestId: SignInRequestId; environment: EnvironmentName; email: string }): Promise<unknown>;
  startPhone(options: { requestId: SignInRequestId; environment: EnvironmentName; phone: string }): Promise<unknown>;
  startGoogle(options: { requestId: SignInRequestId; environment: EnvironmentName }): Promise<unknown>;
  reauthenticate(options: SignInOptions): Promise<unknown>;
  resend(options: RequestOptions): Promise<unknown>;
  verify(options: { requestId: SignInRequestId; code: SignInCode; method?: SecondFactor }): Promise<unknown>;
  sendFactorCode(options: RequestOptions): Promise<unknown>;
  cancel(options: RequestOptions): Promise<unknown>;
  signOut(): Promise<unknown>;
  status(options: ReadinessOptions): Promise<unknown>;
  serviceInfo(options: EnvironmentOptions): Promise<unknown>;
  addListener(eventName: keyof SignInEvents, listener: (event: unknown) => void): Promise<PluginListenerHandle>;
}

export interface SignInClient {
  start(options: SignInOptions): Promise<SignInProgress>;
  reauthenticate(options: SignInOptions): Promise<SignInProgress>;
  resend(options: RequestOptions): Promise<SignInProgress>;
  verify(options: VerifyOptions): Promise<SignInProgress>;
  sendFactorCode(options: RequestOptions): Promise<RequestOptions>;
  cancel(options: RequestOptions): Promise<boolean>;
  signOut(): Promise<SignInAccount>;
  status(options: ReadinessOptions): Promise<SignInStatus>;
  readiness(options: ReadinessOptions): Promise<SignInReadiness>;
  serviceDocument(options: EnvironmentOptions): Promise<ServiceDocument>;
  addListener<Name extends keyof SignInEvents>(eventName: Name, listener: (event: SignInEvents[Name]) => void): Promise<PluginListenerHandle>;
}
