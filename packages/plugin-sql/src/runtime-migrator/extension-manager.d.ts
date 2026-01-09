import type { DrizzleDB } from "./types";
export declare class ExtensionManager {
  private db;
  constructor(db: DrizzleDB);
  installRequiredExtensions(extensions: string[]): Promise<void>;
}
//# sourceMappingURL=extension-manager.d.ts.map
