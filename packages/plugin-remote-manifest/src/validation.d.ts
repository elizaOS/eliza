import { type JsonValue, type RemotePluginManifest } from "./types.js";
export interface RemotePluginManifestValidationIssue {
    path: string;
    message: string;
}
export type RemotePluginManifestValidationResult = {
    ok: true;
    manifest: RemotePluginManifest;
} | {
    ok: false;
    issues: RemotePluginManifestValidationIssue[];
};
export declare function isValidRemotePluginId(value: string): boolean;
export declare function validateRemotePluginManifest(value: JsonValue): RemotePluginManifestValidationResult;
//# sourceMappingURL=validation.d.ts.map