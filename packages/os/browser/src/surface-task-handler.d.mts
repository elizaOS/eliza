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

export interface SurfaceTaskHandler {
  (message: unknown, options?: { readonly signal?: { readonly aborted: boolean } }): Promise<unknown>;
  close(): Promise<void>;
}

export function createSurfaceTaskHandler(ports: SurfaceTaskPorts): SurfaceTaskHandler;

export * from "./native-wire.mjs";
