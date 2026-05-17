/**
 * Canonical runtime-mode resolver for the AGENTS.md §1/§5 contract.
 *
 * Eliza ships in three top-level runtime shapes — `local`, `cloud`, `remote`
 * — plus a `local-only` sub-state of `local` that hides every cloud-routed
 * surface. This module is the single source of truth that the API layer,
 * the local-inference service, and the UI bridge all read from.
 *
 * Resolution order (highest precedence first):
 *   1. `config.deploymentTarget.runtime` — the persisted onboarding choice.
 *   2. (local only) `config.cloud.enabled === false` collapses `local` to
 *      `local-only`.
 *
 * The `RUNTIME_EXECUTION_MODE` env var family in
 * `@elizaos/shared/config/runtime-mode.ts` is a *different* concept (sandbox
 * vs. yolo execution policy for shell tools); do not conflate.
 */
import { type DeploymentTargetConfig } from "@elizaos/shared";
import { z } from "zod";
export declare const RUNTIME_MODES: readonly ["local", "local-only", "cloud", "remote"];
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export interface RuntimeModeSnapshot {
    mode: RuntimeMode;
    deploymentTarget: DeploymentTargetConfig | null;
    /** Present iff `mode === "remote"`. The local-instance HTTP base the
     *  controller proxies to. Cloud/public bases are rejected here too so
     *  stale or hand-edited config cannot turn remote mode into cloud mode. */
    remoteApiBase: string | null;
    /** Populated when a remote target was configured but rejected. */
    remoteApiBaseError: string | null;
    remoteAccessToken: string | null;
}
declare const RuntimeModeConfigSchema: z.ZodObject<{
    deploymentTarget: z.ZodOptional<z.ZodUnknown>;
    cloud: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$loose>;
type RuntimeModeConfigShape = z.infer<typeof RuntimeModeConfigSchema>;
/**
 * Pure resolver — no I/O. Use this when you already hold the config object
 * (route handlers usually do) so the caller picks the load strategy.
 */
export declare function resolveRuntimeMode(config: RuntimeModeConfigShape | null | undefined): RuntimeModeSnapshot;
/**
 * Disk-backed resolver. Reads `eliza.json` from the canonical config path.
 * Use this from request handlers — `loadElizaConfig` is already memoised
 * for the lifetime of the agent runtime.
 */
export declare function getRuntimeMode(): RuntimeMode;
/** Disk-backed snapshot. */
export declare function getRuntimeModeSnapshot(): RuntimeModeSnapshot;
/** True for both `local` and `local-only`. */
export declare function isLocalRuntime(mode: RuntimeMode): boolean;
export interface RemoteApiBaseValidationOk {
    ok: true;
    href: string;
}
export interface RemoteApiBaseValidationErr {
    ok: false;
    error: string;
}
export type RemoteApiBaseValidation = RemoteApiBaseValidationOk | RemoteApiBaseValidationErr;
/**
 * Remote mode is a thin controller for another local/private Eliza instance,
 * never for Eliza Cloud or a public model API. Accept loopback, private
 * RFC1918/CGNAT/link-local hosts, and .local mDNS names.
 */
export declare function validateRemoteApiBase(value: string | null | undefined): RemoteApiBaseValidation;
export declare function isLocalRemoteHost(hostname: string): boolean;
export {};
//# sourceMappingURL=runtime-mode.d.ts.map