import type { CustomActionHandler } from "@elizaos/shared";
export type HandlerType = "http" | "shell" | "code";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export interface ParamDef {
  name: string;
  description: string;
  required: boolean;
}
export interface HeaderRow {
  key: string;
  value: string;
}
export interface ParsedGeneration {
  name: string;
  description: string;
  handlerType: HandlerType;
  handler: CustomActionHandler;
  parameters: ParamDef[];
  similes: string[];
  enabled: boolean;
}
export declare const HTTP_METHODS: readonly [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
];
export declare const editorDialogContentClassName =
  "w-[min(calc(100%_-_2rem),48rem)] max-h-[min(90vh,56rem)] overflow-hidden rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl backdrop-blur-xl";
export declare const editorFieldLabelClassName = "text-xs text-muted";
export declare const editorInputClassName =
  "rounded-xl border-border bg-surface text-txt placeholder:text-muted/50 focus-visible:ring-accent/25";
export declare const editorTextareaClassName =
  "rounded-xl border-border bg-surface text-txt placeholder:text-muted/50 focus-visible:ring-accent/25 resize-none";
export declare const editorMonoTextareaClassName =
  "rounded-xl border-border bg-surface text-txt placeholder:text-muted/50 focus-visible:ring-accent/25 resize-none font-mono";
export declare const editorSectionCardClassName =
  "flex flex-col gap-3 rounded-xl border border-border/70 bg-bg/20 p-3";
export declare function toNonEmptyString(value: unknown): string | undefined;
export declare function normalizeActionName(value: string): string;
export declare function normalizeAlias(value: string): string;
export declare function normalizeParamName(value: string): string;
export declare function normalizeMethod(value: unknown): HttpMethod;
export declare function parseHeaders(value: unknown): HeaderRow[];
export declare function parseParameters(value: unknown): ParamDef[];
export declare function parseSimiles(value: unknown): string[];
export declare function parseGeneratedAction(payload: unknown): {
  ok: boolean;
  action?: ParsedGeneration;
  errors: string[];
};
export declare function parseSimilesInput(value: string): string[];
export declare function validateParameters(items: ParamDef[]): string | null;
//# sourceMappingURL=custom-action-form.d.ts.map
