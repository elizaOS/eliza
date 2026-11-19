// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"
import type { Brand } from "effect";
import type { BodyHandoff, CallRefusal } from "../../../gen/os__signIn__cloudRequests.ts";
import type { EnvironmentName } from "./sign-in.ts";

export type { BodyHandoff, CallRefusal, EnvironmentName };

export type CloudMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type CloudPath = string & Brand.Brand<"CloudPath">;

export type BodyGrantId = string & Brand.Brand<"BodyGrantId">;

export type CloudFailure =
  | "no-origin"
  | "not-listed"
  | "body-too-large"
  | "header-refused"
  | "sign-in-required"
  | "reauth-required"
  | "reply-too-large"
  | "network"
  | "not-configured"
  | "unknown-environment"
  | "invalid-request"
  | "grant-unknown"
  | "grant-unreadable"
  | "link-refused"
  | "no-browser";

export interface CloudRequest {
  readonly method: CloudMethod;
  readonly path: CloudPath;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly environment?: EnvironmentName;
}

export interface CloudReply {
  readonly status: number;
  readonly etag?: string;
  readonly contentType?: string;
  readonly retryAfter?: string;
  readonly body: Uint8Array;
}

export interface ExternalLinkOptions {
  readonly url: string;
  readonly environment?: EnvironmentName;
}

export interface NativeCloudRequest {
  readonly method: CloudMethod;
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly environment?: EnvironmentName;
}

export interface ElizaCloudPlugin {
  request(options: NativeCloudRequest): Promise<unknown>;
  readGrant(options: { readonly grant: BodyGrantId }): Promise<unknown>;
  openExternal(options: ExternalLinkOptions): Promise<unknown>;
}

export interface CloudClient {
  request(request: CloudRequest): Promise<CloudReply>;
  openExternal(options: ExternalLinkOptions): Promise<void>;
}
