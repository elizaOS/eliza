export interface SurfacePage {
  readonly id: string;
  readonly url: string;
  readonly title?: string;
  isCurrent(): boolean;
}

export interface SurfaceControlReply {
  readonly documentId?: string;
  readonly frameScope?: string;
  readonly result?: unknown;
}

export interface SurfaceTaskPorts {
  getPage(id?: string): Promise<SurfacePage | null | undefined>;
  listPages(): Promise<readonly { readonly id: string }[]>;
  control(
    page: SurfacePage,
    request: { readonly documentId?: string; readonly command: Readonly<Record<string, unknown>> },
    signal?: { readonly aborted: boolean },
  ): Promise<SurfaceControlReply>;
  cleanup(id: string, kind: "hide" | "pause"): Promise<unknown>;
  isCurrent(): boolean;
}

export interface SurfaceTargetValidation {
  readonly type: "validate-target";
  readonly id: string;
  readonly command: {
    readonly id: string;
    readonly taskContext: {
      readonly actorId: string;
      readonly accountId: string;
      readonly agentId: string;
      readonly taskId: string;
      readonly epoch: number;
    };
    readonly taskExpiresAt?: number;
    readonly selector: string;
    readonly expectedSelector: string;
    readonly commitGrant?: never;
  } & (
    | { readonly subaction: "click" | "follow" }
    | { readonly subaction: "fill" | "select"; readonly text: string }
    | { readonly subaction: "scroll"; readonly direction?: string }
  );
}

export interface SurfaceTaskHandler {
  (message: SurfaceTargetValidation, options?: { readonly signal?: { readonly aborted: boolean } }): Promise<{ readonly validated: true }>;
  (message: unknown, options?: { readonly signal?: { readonly aborted: boolean } }): Promise<unknown>;
  close(): Promise<void>;
}

/** @throws {never} */
export function createSurfaceTaskHandler(ports: SurfaceTaskPorts): SurfaceTaskHandler;

export * from "./native-wire.mjs";
