import type { StoredEntry } from "./types.js";
export interface StoreData {
    readonly version: number;
    readonly entries: Readonly<Record<string, StoredEntry>>;
}
export declare function readStore(path: string): Promise<StoreData>;
export declare function writeStore(path: string, data: StoreData): Promise<void>;
export declare function setEntry(data: StoreData, key: string, entry: StoredEntry): StoreData;
export declare function removeEntry(data: StoreData, key: string): StoreData;
//# sourceMappingURL=store.d.ts.map