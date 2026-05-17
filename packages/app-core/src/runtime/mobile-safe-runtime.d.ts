export type MobileSafeRuntimePlatform = "ios" | "android" | "web" | "unknown";
export type MobileSafeRuntimeProviderKind = "android-avf-microdroid" | "safe-js-applet" | "javascriptcore" | "quickjs" | "wasm" | "android-isolated-process";
export type AndroidAvfMicrodroidCapabilityState = "unsupported-platform" | "unsupported-api" | "framework-unavailable" | "permission-denied" | "service-unavailable" | "payload-missing" | "ready";
export type MobileSafeRuntimeCapability = "fs.read" | "fs.write" | "fs.delete" | "fs.mkdir" | "fs.stat" | "fs.list" | "fs.snapshot" | "fs.diff" | "fs.rollback" | "fs.quota" | "net.fetch" | "crypto.random" | "model.inference" | "shell.exec" | "app.compile" | "app.load" | "app.run" | (string & {});
export interface MobileSafeRuntimeFeatureProbe {
    env?: Record<string, string | undefined>;
    globals?: Record<string, unknown>;
    platform?: MobileSafeRuntimePlatform;
    androidAvfAvailable?: boolean;
    androidMicrodroidAvailable?: boolean;
    androidAvfPayloadAvailable?: boolean;
    androidAvfCapabilityState?: AndroidAvfMicrodroidCapabilityState;
    androidIsolatedProcessAvailable?: boolean;
    iosJavaScriptCoreAvailable?: boolean;
    iosQuickJsAvailable?: boolean;
    allowInProcessSafeJsApplet?: boolean;
}
export interface AndroidAvfMicrodroidRuntimeStatus {
    state: AndroidAvfMicrodroidCapabilityState;
    available: boolean;
    avfAvailable: boolean;
    microdroidAvailable: boolean;
    payloadAvailable: boolean;
    capabilities: string[];
    reason?: string;
}
export interface MobileSafeRuntimeFeatures {
    platform: MobileSafeRuntimePlatform;
    supportsWebAssembly: boolean;
    supportsDynamicImport: boolean;
    supportsSharedArrayBuffer: boolean;
    hasNodeRuntime: boolean;
    hasBunRuntime: boolean;
    availableProviders: MobileSafeRuntimeProviderKind[];
    unavailableProviders: Partial<Record<MobileSafeRuntimeProviderKind, string>>;
    androidAvfMicrodroid: AndroidAvfMicrodroidRuntimeStatus;
}
export interface MobileSafeRuntimeFileInfo {
    path: string;
    kind: "file" | "directory";
    size: number;
    updatedAt?: number;
}
export type MobileSafeRuntimeDiffStatus = "added" | "modified" | "deleted";
export interface MobileSafeRuntimeSnapshot {
    id: string;
    createdAt: number;
    note?: string;
    filesBytes: number;
    fileCount: number;
}
export interface MobileSafeRuntimeDiffEntry {
    path: string;
    status: MobileSafeRuntimeDiffStatus;
    before?: MobileSafeRuntimeFileInfo;
    after?: MobileSafeRuntimeFileInfo;
}
export interface MobileSafeRuntimeQuota {
    usedBytes: number;
    fileCount: number;
    quotaBytes?: number;
    maxFileBytes?: number;
}
export interface MobileSafeVirtualFileSystem {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    stat(path: string): Promise<MobileSafeRuntimeFileInfo | null>;
    list(path: string): Promise<MobileSafeRuntimeFileInfo[]>;
    createSnapshot?(note?: string): Promise<MobileSafeRuntimeSnapshot>;
    diffCurrent?(snapshotId: string): Promise<MobileSafeRuntimeDiffEntry[]>;
    rollback?(snapshotId: string): Promise<void>;
    quota?(): Promise<MobileSafeRuntimeQuota>;
}
export interface MobileSafeRuntimeCapabilityRequest<TArgs extends Record<string, unknown> = Record<string, unknown>> {
    id: string;
    capability: MobileSafeRuntimeCapability;
    operation: string;
    args: TArgs;
    subject?: string;
    timeoutMs?: number;
}
export type MobileSafeRuntimeCapabilityResponse<TResult = unknown> = {
    id: string;
    ok: true;
    result: TResult;
} | {
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
        retryable?: boolean;
    };
};
export interface MobileSafeCapabilityBroker {
    call<TResult = unknown>(request: MobileSafeRuntimeCapabilityRequest): Promise<MobileSafeRuntimeCapabilityResponse<TResult>>;
}
export interface MobileSafeRuntimeExecuteInput {
    code: string;
    entrypoint?: string;
    env?: Record<string, string>;
    files?: MobileSafeVirtualFileSystem;
    broker?: MobileSafeCapabilityBroker;
    mode?: "evaluate" | "compile-app" | "load-app" | "run-app" | "shell";
    applet?: MobileSafeRuntimeAppletExecuteOptions;
    signal?: AbortSignal;
}
export type MobileSafeRuntimeExecuteResult = {
    ok: true;
    value: unknown;
    logs?: string[];
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        provider: MobileSafeRuntimeProviderKind;
    };
    logs?: string[];
};
export interface MobileSafeRuntimeProvider {
    kind: MobileSafeRuntimeProviderKind;
    displayName: string;
    supported: boolean;
    reason?: string;
    execute(input: MobileSafeRuntimeExecuteInput): Promise<MobileSafeRuntimeExecuteResult>;
}
export type MobileSafeAppletModuleFormat = "javascript" | "typescript";
export interface MobileSafeAppletManifest {
    id: string;
    version: string;
    name?: string;
    description?: string;
    runtime?: "mobile-safe-js";
    entrypoint: string;
    moduleFormat?: MobileSafeAppletModuleFormat;
    files?: string[];
    permissions?: MobileSafeRuntimeCapability[];
    env?: Record<string, string>;
    createdAt?: number;
    compiled?: {
        bundlePath: string;
        compiledAt: number;
        sourceHash: string;
        files: string[];
    };
}
export interface MobileSafeCompiledApplet {
    manifestPath: string;
    bundlePath: string;
    manifest: MobileSafeAppletManifest;
    sourceHash: string;
    files: string[];
}
export interface MobileSafeLoadedApplet {
    manifestPath: string;
    bundlePath: string;
    manifest: MobileSafeAppletManifest;
    bundle: string;
}
export interface MobileSafeRuntimeAppletExecuteOptions {
    manifestPath?: string;
    appRoot?: string;
    bundlePath?: string;
    input?: unknown;
}
export interface CompileMobileSafeAppletOptions {
    files: MobileSafeVirtualFileSystem;
    manifest?: MobileSafeAppletManifest;
    manifestPath?: string;
    appRoot?: string;
    outputPath?: string;
}
export interface IosJavaScriptCoreBoundary {
    kind: "javascriptcore";
    evaluateScript(script: string): Promise<unknown>;
}
export interface IosQuickJsBoundary {
    kind: "quickjs";
    evaluateModule(moduleSource: string, entrypoint?: string): Promise<unknown>;
}
export interface AndroidIsolatedProcessBoundary {
    kind: "android-isolated-process";
    serviceName: string;
    request(request: MobileSafeRuntimeCapabilityRequest): Promise<MobileSafeRuntimeCapabilityResponse>;
}
export interface AndroidAvfMicrodroidBoundary {
    kind: "android-avf-microdroid";
    capabilityState?: AndroidAvfMicrodroidCapabilityState;
    reason?: string;
    capabilities?: string[];
    request(request: MobileSafeRuntimeCapabilityRequest): Promise<MobileSafeRuntimeCapabilityResponse>;
}
export interface AndroidIsolatedProcessHook {
    serviceName: string;
    intentAction: string;
    binderInterface: string;
    requiredPermission?: string;
    processName?: string;
}
export declare function detectMobileSafeRuntimeFeatures(probe?: MobileSafeRuntimeFeatureProbe): MobileSafeRuntimeFeatures;
export declare function createAndroidAvfMicrodroidProvider(boundary?: AndroidAvfMicrodroidBoundary): MobileSafeRuntimeProvider;
export declare function createUnavailableMobileSafeRuntimeProvider(kind: MobileSafeRuntimeProviderKind, reason: string): MobileSafeRuntimeProvider;
export declare function createIosJavaScriptCoreProvider(boundary?: IosJavaScriptCoreBoundary): MobileSafeRuntimeProvider;
export declare function createIosQuickJsProvider(boundary?: IosQuickJsBoundary): MobileSafeRuntimeProvider;
export declare function createInProcessSafeJsAppletProvider(options?: {
    now?: () => number;
}): MobileSafeRuntimeProvider;
export declare function writeMobileSafeAppletManifest(files: MobileSafeVirtualFileSystem, manifest: MobileSafeAppletManifest, manifestPath?: string): Promise<MobileSafeAppletManifest>;
export declare function readMobileSafeAppletManifest(files: MobileSafeVirtualFileSystem, manifestPath?: string): Promise<MobileSafeAppletManifest>;
export declare function compileMobileSafeApplet(options: CompileMobileSafeAppletOptions): Promise<MobileSafeCompiledApplet>;
export declare function loadMobileSafeApplet(options: {
    files: MobileSafeVirtualFileSystem;
    manifestPath?: string;
}): Promise<MobileSafeLoadedApplet>;
export declare function createAndroidIsolatedProcessHook(options?: Partial<AndroidIsolatedProcessHook>): AndroidIsolatedProcessHook;
export declare function createAndroidIsolatedProcessProvider(boundary?: AndroidIsolatedProcessBoundary): MobileSafeRuntimeProvider;
export declare function createMobileSafeCapabilityBroker(handler: (request: MobileSafeRuntimeCapabilityRequest) => Promise<MobileSafeRuntimeCapabilityResponse> | MobileSafeRuntimeCapabilityResponse): MobileSafeCapabilityBroker;
export declare function createMobileSafeVirtualFileSystemBroker(files: MobileSafeVirtualFileSystem): MobileSafeCapabilityBroker;
export interface AgentVirtualFilesystemLike {
    readFile?(path: string): Promise<string>;
    readFileBytes?(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<unknown>;
    delete?(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    list?(path?: string, options?: {
        recursive?: boolean;
    }): Promise<Array<{
        path: string;
        type?: "file" | "directory";
        kind?: "file" | "directory";
        size: number;
        mtimeMs?: number;
        updatedAt?: number;
    }>>;
    createSnapshot?(note?: string): Promise<{
        id: string;
        createdAt?: string | number;
        note?: string;
        filesBytes: number;
        fileCount: number;
    }>;
    diffCurrent?(snapshotId: string): Promise<Array<{
        path: string;
        status: MobileSafeRuntimeDiffStatus;
        before?: {
            path: string;
            type?: "file" | "directory";
            kind?: "file" | "directory";
            size: number;
            mtimeMs?: number;
            updatedAt?: number;
        };
        after?: {
            path: string;
            type?: "file" | "directory";
            kind?: "file" | "directory";
            size: number;
            mtimeMs?: number;
            updatedAt?: number;
        };
    }>>;
    rollback?(snapshotId: string): Promise<unknown>;
    quota?(): Promise<MobileSafeRuntimeQuota>;
    quotaBytes?: number;
    maxFileBytes?: number;
}
export declare function createMobileSafeVirtualFileSystemAdapter(vfs: AgentVirtualFilesystemLike): MobileSafeVirtualFileSystem;
export declare function selectMobileSafeRuntimeProvider(options: {
    features: MobileSafeRuntimeFeatures;
    providers: Partial<Record<MobileSafeRuntimeProviderKind, MobileSafeRuntimeProvider>>;
    preferredOrder?: MobileSafeRuntimeProviderKind[];
}): MobileSafeRuntimeProvider;
export declare function normalizeMobileSafePath(path: string): string;
export declare class MemoryMobileSafeVirtualFileSystem implements MobileSafeVirtualFileSystem {
    readonly quotaBytes?: number;
    readonly maxFileBytes?: number;
    private readonly files;
    private readonly directories;
    private readonly snapshots;
    private snapshotCounter;
    constructor(options?: {
        quotaBytes?: number;
        maxFileBytes?: number;
    });
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    delete(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    stat(path: string): Promise<MobileSafeRuntimeFileInfo | null>;
    list(path: string): Promise<MobileSafeRuntimeFileInfo[]>;
    createSnapshot(note?: string): Promise<MobileSafeRuntimeSnapshot>;
    diffCurrent(snapshotId: string): Promise<MobileSafeRuntimeDiffEntry[]>;
    rollback(snapshotId: string): Promise<void>;
    quota(): Promise<MobileSafeRuntimeQuota>;
    private usedBytes;
    private ensureDirectoryPath;
}
//# sourceMappingURL=mobile-safe-runtime.d.ts.map