export interface PluginAnalysis {
  typeCheck: {
    success: boolean;
    errors: Array<{
      file: string;
      line: number;
      column: number;
      message: string;
      code: string;
    }>;
  };
  biome: {
    results: {
      lint: {
        diagnostics: Array<{
          file: string;
          message: string;
          severity: string;
          rule: string;
        }>;
      };
    };
  };
  dependencies: {
    dependencies: {
      circular: string[];
      unused: string[];
      missing: string[];
    };
  };
  duplicates: {
    report: {
      duplicates: Array<{
        files: string[];
        lines: number;
        tokens: number;
      }>;
    };
  };
}