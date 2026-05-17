import type { BackgroundKind } from "./types";
export interface BackgroundEditPayload {
    id: string;
    sourceCode: string;
    kind: BackgroundKind;
    fpsBudget: number;
}
export interface BackgroundEditAction {
    type: "BACKGROUND_EDIT";
    payload: BackgroundEditPayload;
}
export declare const BACKGROUND_EDIT_ACTION_TYPE: "BACKGROUND_EDIT";
//# sourceMappingURL=BACKGROUND_EDIT-action-contract.d.ts.map