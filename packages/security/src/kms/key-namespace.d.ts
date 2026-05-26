import type { KeyId, KeyVersion } from "./types.js";
export type KeyScope = "system" | "org" | "user";
export interface SystemKeyParts {
    scope: "system";
    purpose: string;
    version: KeyVersion;
}
export interface OrgKeyParts {
    scope: "org";
    orgId: string;
    purpose: "dek" | "hmac";
    version: KeyVersion;
}
export interface UserKeyParts {
    scope: "user";
    userId: string;
    purpose: "connector";
    version: KeyVersion;
}
export type KeyParts = SystemKeyParts | OrgKeyParts | UserKeyParts;
export declare function systemKey(purpose: string, version?: KeyVersion): KeyId;
export declare function orgKey(orgId: string, purpose: "dek" | "hmac", version?: KeyVersion): KeyId;
export declare function userKey(userId: string, purpose: "connector", version?: KeyVersion): KeyId;
export declare function parseKeyId(id: KeyId): KeyParts;
export declare function isValidKeyId(id: string): id is KeyId;
export declare function withVersion(id: KeyId, version: KeyVersion): KeyId;
export declare function baseKeyId(id: KeyId): string;
//# sourceMappingURL=key-namespace.d.ts.map