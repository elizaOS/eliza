import { Effect, Schema } from "effect";
declare const View: Schema.Struct<{
    readonly id: Schema.String;
    readonly label: Schema.String;
    readonly path: Schema.String;
    readonly aliases: Schema.optionalKey<Schema.$Array<Schema.String>>;
}>;
export declare const LaunchDocument: Schema.Struct<{
    readonly schema: Schema.Literal<1>;
    readonly character: Schema.Struct<{
        readonly name: Schema.String;
        readonly system: Schema.String;
        readonly bio: Schema.optionalKey<Schema.Union<readonly [Schema.String, Schema.$Array<Schema.String>]>>;
        readonly adjectives: Schema.optionalKey<Schema.$Array<Schema.String>>;
        readonly style: Schema.optionalKey<Schema.Struct<{
            readonly all: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly chat: Schema.optionalKey<Schema.$Array<Schema.String>>;
            readonly post: Schema.optionalKey<Schema.$Array<Schema.String>>;
        }>>;
        readonly messageExamples: Schema.optionalKey<Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly examples: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly content: Schema.Struct<{
                    readonly text: Schema.optionalKey<Schema.String>;
                    readonly actions: Schema.optionalKey<Schema.$Array<Schema.String>>;
                }>;
            }>>;
        }>, Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly content: Schema.Struct<{
                readonly text: Schema.optionalKey<Schema.String>;
                readonly actions: Schema.optionalKey<Schema.$Array<Schema.String>>;
            }>;
        }>>]>>>;
    }>;
    readonly policy: Schema.Struct<{
        readonly actions: Schema.Struct<{
            readonly allowed: Schema.$Array<Schema.String>;
        }>;
        readonly plugins: Schema.Struct<{
            readonly load: Schema.$Array<Schema.String>;
            readonly product: Schema.optionalKey<Schema.String>;
        }>;
    }>;
    readonly model: Schema.Union<readonly [Schema.Struct<{
        readonly backend: Schema.Literal<"cloud">;
        readonly cloudBaseUrl: Schema.String;
        readonly smallModel: Schema.String;
        readonly largeModel: Schema.String;
        readonly imageModel: Schema.String;
    }>, Schema.Struct<{
        readonly backend: Schema.Literal<"own-key">;
        readonly ownKeyBaseUrl: Schema.String;
        readonly ownKeySmall: Schema.String;
        readonly ownKeyLarge: Schema.String;
    }>, Schema.Struct<{
        readonly backend: Schema.Literal<"none">;
    }>]>;
    readonly account: Schema.optionalKey<Schema.Struct<{
        readonly userId: Schema.String;
        readonly organizationId: Schema.String;
    }>>;
    readonly embeddings: Schema.Literals<readonly ["local", "none"]>;
    readonly embeddingDimensions: Schema.optionalKey<Schema.Int>;
    readonly persistMemory: Schema.optionalKey<Schema.Boolean>;
    readonly callerRole: Schema.Literals<readonly ["owner", "user"]>;
    readonly views: Schema.optionalKey<Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly label: Schema.String;
        readonly path: Schema.String;
        readonly aliases: Schema.optionalKey<Schema.$Array<Schema.String>>;
    }>>>;
    readonly timeZone: Schema.optionalKey<Schema.String>;
    readonly privacy: Schema.optionalKey<Schema.Struct<{
        readonly secretSwap: Schema.Boolean;
        readonly piiSwap: Schema.Boolean;
    }>>;
    readonly google: Schema.optionalKey<Schema.Struct<{
        readonly gmailChanges: Schema.Boolean;
        readonly calendarEdits: Schema.Boolean;
    }>>;
    readonly workflowWorker: Schema.optionalKey<Schema.Struct<{
        readonly runtimeDir: Schema.String;
        readonly executable: Schema.String;
        readonly sha256: Schema.String;
    }>>;
    readonly retention: Schema.optionalKey<Schema.Struct<{
        readonly days: Schema.Number;
        readonly maxRowsPerRoom: Schema.Int;
        readonly intervalMinutes: Schema.Int;
    }>>;
    readonly hostContextRevision: Schema.optionalKey<Schema.Int>;
    readonly environment: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
}>;
export declare const LaunchFrame: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly token: Schema.RedactedFromValue<Schema.String>;
    readonly epoch: Schema.Int;
    readonly credential: Schema.optionalKey<Schema.Struct<{
        readonly version: Schema.Int;
        readonly value: Schema.RedactedFromValue<Schema.String>;
    }>>;
    readonly storageKey: Schema.optionalKey<Schema.RedactedFromValue<Schema.String>>;
}>;
export type LaunchDocument = typeof LaunchDocument.Type;
export type LaunchFrame = typeof LaunchFrame.Type;
export type ViewDeclaration = typeof View.Type;
declare const LaunchDocumentRejected_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "LaunchDocumentRejected";
} & Readonly<A>;
export declare class LaunchDocumentRejected extends LaunchDocumentRejected_base {
}
declare const LaunchFrameRejected_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "LaunchFrameRejected";
} & Readonly<A>;
export declare class LaunchFrameRejected extends LaunchFrameRejected_base {
}
export declare const decodeLaunchDocument: (input: string) => Effect.Effect<{
    readonly schema: 1;
    readonly character: {
        readonly name: string;
        readonly system: string;
        readonly bio?: string | readonly string[] | undefined;
        readonly adjectives?: readonly string[] | undefined;
        readonly style?: {
            readonly all?: readonly string[] | undefined;
            readonly chat?: readonly string[] | undefined;
            readonly post?: readonly string[] | undefined;
        } | undefined;
        readonly messageExamples?: readonly (readonly {
            readonly name: string;
            readonly content: {
                readonly text?: string | undefined;
                readonly actions?: readonly string[] | undefined;
            };
        }[] | {
            readonly examples: readonly {
                readonly name: string;
                readonly content: {
                    readonly text?: string | undefined;
                    readonly actions?: readonly string[] | undefined;
                };
            }[];
        })[] | undefined;
    };
    readonly policy: {
        readonly actions: {
            readonly allowed: readonly string[];
        };
        readonly plugins: {
            readonly load: readonly string[];
            readonly product?: string | undefined;
        };
    };
    readonly model: {
        readonly backend: "cloud";
        readonly cloudBaseUrl: string;
        readonly smallModel: string;
        readonly largeModel: string;
        readonly imageModel: string;
    } | {
        readonly backend: "own-key";
        readonly ownKeyBaseUrl: string;
        readonly ownKeySmall: string;
        readonly ownKeyLarge: string;
    } | {
        readonly backend: "none";
    };
    readonly account?: {
        readonly userId: string;
        readonly organizationId: string;
    } | undefined;
    readonly embeddings: "local" | "none";
    readonly embeddingDimensions?: number | undefined;
    readonly persistMemory?: boolean | undefined;
    readonly callerRole: "owner" | "user";
    readonly views?: readonly {
        readonly id: string;
        readonly label: string;
        readonly path: string;
        readonly aliases?: readonly string[] | undefined;
    }[] | undefined;
    readonly timeZone?: string | undefined;
    readonly privacy?: {
        readonly secretSwap: boolean;
        readonly piiSwap: boolean;
    } | undefined;
    readonly google?: {
        readonly gmailChanges: boolean;
        readonly calendarEdits: boolean;
    } | undefined;
    readonly workflowWorker?: {
        readonly runtimeDir: string;
        readonly executable: string;
        readonly sha256: string;
    } | undefined;
    readonly retention?: {
        readonly days: number;
        readonly maxRowsPerRoom: number;
        readonly intervalMinutes: number;
    } | undefined;
    readonly hostContextRevision?: number | undefined;
    readonly environment?: {
        readonly [x: string]: string;
    } | undefined;
}, LaunchDocumentRejected, never>;
export declare const decodeLaunchFrame: (input: string) => Effect.Effect<{
    readonly version: 1;
    readonly token: import("effect/Redacted").Redacted<string>;
    readonly epoch: number;
    readonly credential?: {
        readonly version: number;
        readonly value: import("effect/Redacted").Redacted<string>;
    } | undefined;
    readonly storageKey?: import("effect/Redacted").Redacted<string> | undefined;
}, LaunchFrameRejected, never>;
export {};
