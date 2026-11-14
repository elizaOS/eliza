// A stand-in for what `spec gen` writes from spec/index.md: the exports the story generator reads.
export type Status = "Draft" | "Paid";
export interface Order { status: Status; units: number }
export type Event = { type: "addItem"; qty: number } | { type: "pay" };
export const initial: Order = { status: "Draft", units: 0 };
