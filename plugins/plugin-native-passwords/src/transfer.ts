/**
 * Vault export/import bridge. Both operations run natively: export needs a fresh
 * device authentication, an explicit confirmation and a user-picked document; import shows the
 * exact HTTPS origin of every row before anything is added. Results carry counts only.
 */
export interface PasswordExportResult {
  exported: number;
}
export interface PasswordImportResult {
  imported: number;
  skipped: number;
}
export interface ElizaPasswordTransferPlugin {
  exportVault(): Promise<PasswordExportResult>;
  importVault(): Promise<PasswordImportResult>;
}

const count = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 100000;

/** Revalidates native results so only the documented counts ever reach the host UI. */
export function createTransferClient(plugin: ElizaPasswordTransferPlugin) {
  return {
    async exportVault(): Promise<PasswordExportResult> {
      const result = (await plugin.exportVault()) as unknown as Record<
        string,
        unknown
      >;
      if (
        !result ||
        !count(result.exported) ||
        Object.keys(result).some((key) => key !== "exported")
      )
        throw new Error("Unexpected export result");
      return { exported: result.exported as number };
    },
    async importVault(): Promise<PasswordImportResult> {
      const result = (await plugin.importVault()) as unknown as Record<
        string,
        unknown
      >;
      if (
        !result ||
        !count(result.imported) ||
        !count(result.skipped) ||
        Object.keys(result).some(
          (key) => key !== "imported" && key !== "skipped",
        )
      )
        throw new Error("Unexpected import result");
      return {
        imported: result.imported as number,
        skipped: result.skipped as number,
      };
    },
  };
}
export type PasswordTransferClient = ReturnType<typeof createTransferClient>;
