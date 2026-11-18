// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"; spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
import type { PluginListenerHandle } from "@capacitor/core";
import type { Brand } from "effect";
import type { RevokeReply } from "../../../gen/os__signIn__credential.ts";
import type { GoogleMode, ServiceOutcome } from "../../../gen/os__signIn__readiness.ts";

export type { GoogleMode, RevokeReply, ServiceOutcome };

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

export type SignInStart =
  | { method: "email"; email: string }
  | { method: "sms"; phone: string }
  | { method: "google" };

export type SignInOptions = SignInStart & { requestId: SignInRequestId; environment: EnvironmentName };

export type ReauthenticateOptions = (SignInStart & { method: "email" | "sms" }) | { method: "google" };

export interface SignInReceipt {
  requestId: SignInRequestId;
  attemptId: SignInAttemptId;
  credentialId: CredentialId;
  google: GoogleOutcome;
}

export type SignInSettled =
  | { kind: "signedIn"; environment: EnvironmentName; receipt: SignInReceipt }
  | { kind: "reauthenticated"; environment: EnvironmentName; requestId: SignInRequestId; attemptId: SignInAttemptId; sessionExpiresAt: number }
  | { kind: "failed"; environment: EnvironmentName; requestId: SignInRequestId; code: SignInFailureCode };

export type SignInProgress =
  | { kind: "codeSent"; requestId: SignInRequestId; attemptId: SignInAttemptId; expiresAt: number; resendAt: number }
  | { kind: "secondFactor"; requestId: SignInRequestId; attemptId: SignInAttemptId; factor: SecondFactor; expiresAt: number }
  | { kind: "browserOpened"; requestId: SignInRequestId; attemptId: SignInAttemptId }
  | Exclude<SignInSettled, { kind: "failed" }>;

export interface SignInRefusalData {
  attemptKept?: true;
  resendAt?: number;
}

export type SignInCustody =
  | { kind: "signedOut" }
  | { kind: "active"; userId: string; organizationId: string; credentialId: CredentialId; keyExpiresAt: number }
  | { kind: "expired"; userId: string; organizationId: string };

export interface OpenSignInRequest {
  requestId: SignInRequestId;
  step: "starting" | "code-sent" | "verifying" | "second-factor" | "exchanging";
}

export interface SignInStatus {
  environment: EnvironmentName;
  custody: SignInCustody;
  request: OpenSignInRequest | null;
}

export interface SignInReadiness {
  environment: EnvironmentName;
  methodsKnown: boolean;
  email: boolean;
  sms: boolean;
  google: boolean;
  googleMode: GoogleMode;
}

export interface ServiceTerms {
  name: string;
  terms: string;
  privacy: string;
}

export type ServiceDocument =
  | { kind: Extract<ServiceOutcome, "ServiceShown">; environment: EnvironmentName; service: ServiceTerms }
  | { kind: Exclude<ServiceOutcome, "ServiceShown">; environment: EnvironmentName };

export interface SignedOut {
  environment: EnvironmentName;
  revoke: RevokeReply;
}

export interface SignInEvents {
  signInSettled: SignInSettled;
  signInReadinessChanged: SignInReadiness;
}

export interface EnvironmentOptions {
  environment: EnvironmentName;
}

export interface ElizaSignInPlugin {
  start(options: SignInOptions): Promise<SignInProgress>;
  verify(options: { requestId: SignInRequestId; code: SignInCode }): Promise<SignInProgress>;
  resend(options: { requestId: SignInRequestId; replaces: SignInRequestId }): Promise<SignInProgress>;
  cancel(options: { requestId: SignInRequestId }): Promise<{ cancelled: boolean }>;
  reauthenticate(options: ReauthenticateOptions & { requestId: SignInRequestId; environment: EnvironmentName }): Promise<SignInProgress>;
  signOut(options: EnvironmentOptions): Promise<SignedOut>;
  status(options: EnvironmentOptions): Promise<SignInStatus>;
  readiness(options: EnvironmentOptions & { retry?: boolean }): Promise<SignInReadiness>;
  serviceDocument(options: EnvironmentOptions): Promise<ServiceDocument>;
  addListener<Name extends keyof SignInEvents>(eventName: Name, listener: (event: SignInEvents[Name]) => void): Promise<PluginListenerHandle>;
}
