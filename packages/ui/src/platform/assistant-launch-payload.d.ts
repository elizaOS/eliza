export declare const ASSISTANT_LAUNCH_TEXT_KEYS: readonly ["text", "q", "query", "body"];
export declare const ASSISTANT_LAUNCH_PARAM_KEYS: readonly ["text", "q", "query", "body", "action", "assistant.launchId", "source"];
export declare const ASSISTANT_LAUNCH_SOURCES: Set<string>;
export interface AssistantLaunchPayload {
    action: string | null;
    launchId: string;
    route: string;
    source: string;
    text: string;
}
export interface AssistantLaunchPayloadClaimOptions {
    allowedRoutes?: readonly string[];
}
export interface AssistantLaunchPayloadSendOptions {
    metadata: Record<string, unknown>;
}
export interface AssistantLaunchPayloadConsumeOptions extends AssistantLaunchPayloadClaimOptions {
    onSendFailure?: (payload: AssistantLaunchPayload, error: unknown) => void;
    sendText: (text: string, options: AssistantLaunchPayloadSendOptions) => Promise<unknown> | unknown;
}
export declare function readAssistantLaunchPayloadFromHash(hash: string): AssistantLaunchPayload | null;
export declare function buildAssistantLaunchMetadata(payload: AssistantLaunchPayload): Record<string, unknown>;
export declare function claimAssistantLaunchPayloadFromHash(hash: string, options?: AssistantLaunchPayloadClaimOptions): AssistantLaunchPayload | null;
export declare function consumeAssistantLaunchPayloadFromHash(hash: string, options: AssistantLaunchPayloadConsumeOptions): Promise<AssistantLaunchPayload | null>;
export declare function clearAssistantLaunchPayloadFromHash(): void;
export declare function __resetAssistantLaunchPayloadClaimsForTests(): void;
//# sourceMappingURL=assistant-launch-payload.d.ts.map