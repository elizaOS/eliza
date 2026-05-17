import type { ConversationMessage } from "../../api/client-types-chat";
import type { PatchOp, UiSpec } from "../../config/ui-spec";

interface MessageContentProps {
  message: ConversationMessage;
  analysisMode?: boolean;
}
export declare function normalizeDisplayText(text: string): string;
/**
 * Quick pre-check: does this line look like a JSON patch object?
 * Handles both compact `{"op":` and spaced `{ "op":` formats.
 */
export declare function looksLikePatch(trimmed: string): boolean;
/** Try to parse a single line as an RFC 6902 JSON Patch operation. */
export declare function tryParsePatch(line: string): PatchOp | null;
/**
 * Apply a list of RFC 6902 patches to build a UiSpec.
 *
 * Only handles the paths the catalog emits:
 *   /root              → spec.root
 *   /elements/<id>     → spec.elements[id]
 *   /state/<key>       → spec.state[key]
 *   /state             → spec.state (whole object)
 */
export declare function compilePatches(patches: PatchOp[]): UiSpec | null;
/**
 * Scan `text` for blocks of consecutive JSONL patch lines and return
 * their character regions plus the compiled UiSpec.
 *
 * A patch block is a run of lines where each non-empty line parses as a
 * valid PatchOp. A single empty line between patch lines is allowed.
 */
export declare function findPatchRegions(text: string): Array<{
  start: number;
  end: number;
  spec: UiSpec;
  raw: string;
}>;
/** Normalize plugin ID: strip @scope/plugin- prefix so both "discord" and "@elizaos/plugin-discord" resolve. */
export declare function normalizePluginId(id: string): string;
export declare function MessageContent({
  message,
  analysisMode,
}: MessageContentProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=MessageContent.d.ts.map
