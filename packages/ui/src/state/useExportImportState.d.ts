/**
 * Agent export/import state — extracted from AppContext.
 *
 * Manages the export/import UI state and the download/upload
 * callbacks. Uses the client singleton directly, matching the
 * pattern of useTriggersState / usePairingState.
 */
export declare function useExportImportState(): {
  state: {
    exportBusy: boolean;
    exportPassword: string;
    exportIncludeLogs: boolean;
    exportError: string | null;
    exportSuccess: string | null;
    importBusy: boolean;
    importPassword: string;
    importFile: File | null;
    importError: string | null;
    importSuccess: string | null;
  };
  setExportPassword: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setExportIncludeLogs: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setExportError: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setExportSuccess: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setImportPassword: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setImportFile: import("react").Dispatch<
    import("react").SetStateAction<File | null>
  >;
  setImportError: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setImportSuccess: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  handleAgentExport: () => Promise<void>;
  handleAgentImport: () => Promise<void>;
};
//# sourceMappingURL=useExportImportState.d.ts.map
