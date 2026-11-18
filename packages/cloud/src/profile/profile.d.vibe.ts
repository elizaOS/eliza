import { Context, Effect, FileSystem, Layer } from "effect";
import { type MethodsAnswer, type Capability as SpecCapability, type EnvironmentProfile as ProfileRow, type Profile as SpecProfile } from "../../gen/cloud__deployment.effect.vibe";
import { CloudEnvironment as EnvironmentSchema, CloudProfile, type Capability, type EnvironmentProfile, type LegalDocument } from "./profile.schema.ts";
export type { Capability, CloudProfile, EnvironmentProfile, LegalDocument };
export type CloudEnvironment = typeof EnvironmentSchema.Type;
declare const ProfileInvalid_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ProfileInvalid";
} & Readonly<A>;
export declare class ProfileInvalid extends ProfileInvalid_base<{
    readonly problem: string;
}> {
}
declare const SecretMissing_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "SecretMissing";
} & Readonly<A>;
export declare class SecretMissing extends SecretMissing_base<{
    readonly name: string;
}> {
}
export declare const capabilityOf: Readonly<Record<Capability, SpecCapability>>;
/** @throws {never} */
export declare function rowOf(name: string, settings: EnvironmentProfile): ProfileRow;
/** @throws {never} */
export declare function specProfile(profile: CloudProfile): SpecProfile;
export declare function parseProfile(input: unknown): Effect.Effect<CloudProfile, ProfileInvalid>;
export declare function parseEnvironment(input: string): Effect.Effect<CloudEnvironment, ProfileInvalid>;
export declare function readProfile(file: string): Effect.Effect<CloudProfile, ProfileInvalid, FileSystem.FileSystem>;
type Deployment_shape = {
    readonly profile: CloudProfile;
    readonly environment: CloudEnvironment;
    readonly settings: EnvironmentProfile;
    secret(name: string): Effect.Effect<string, SecretMissing>;
};
declare const Deployment_base: Context.ServiceClass<Deployment, "@elizaos/cloud/profile/Deployment", Deployment_shape>;
export declare class Deployment extends Deployment_base {
}
export declare namespace Deployment {
    type Shape = Deployment_shape;
}
export declare function deploymentLayer(profile: CloudProfile, environment: CloudEnvironment): Layer.Layer<Deployment>;
export declare function requireSecrets(): Effect.Effect<void, SecretMissing, Deployment>;
/** @throws {never} */
export declare function corsForOrigin(settings: EnvironmentProfile, origin: string): boolean;
/** @throws {never} */
export declare function capabilityEnabled(settings: EnvironmentProfile, capability: Capability): boolean;
/** @throws {never} */
export declare function enabledCapabilities(settings: EnvironmentProfile): ReadonlyArray<Capability>;
/** @throws {never} */
export declare function signInMethods(settings: EnvironmentProfile): MethodsAnswer;
export interface ServiceDocument {
    readonly success: true;
    readonly version: 1;
    readonly service: {
        readonly name: string;
        readonly terms: LegalDocument;
        readonly privacy: LegalDocument;
    };
}
/** @throws {never} */
export declare function serviceDocument(profile: CloudProfile, settings: EnvironmentProfile): ServiceDocument;
