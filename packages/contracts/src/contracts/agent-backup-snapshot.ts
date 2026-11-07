export interface AgentBackupFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode?: number;
  mtimeMs?: number;
  bytesBase64: string;
}
export interface AgentBackupFileSet {
  kind: "file-set";
  rootLabel: "state-dir" | "pglite-dir";
  rootPath?: string;
  files: AgentBackupFileEntry[];
  sha256: string;
}
export interface AgentBackupPostgresTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}
export interface AgentBackupPostgresDump {
  kind: "postgres-rows";
  tables: AgentBackupPostgresTable[];
  sha256: string;
}
export interface AgentBackupPgliteDump {
  kind: "pglite-dump";
  compression: "gzip";
  file: AgentBackupFileEntry;
  sha256: string;
}
export interface AgentBackupDatabaseComponent {
  kind: "pglite-dump" | "pglite-files" | "postgres-rows" | "none";
  pgliteDump?: AgentBackupPgliteDump;
  pglite?: AgentBackupFileSet;
  postgres?: AgentBackupPostgresDump;
  reason?: string;
  sha256: string;
}
export interface AgentBackupManifest {
  schemaVersion: 1;
  format: "elizaos.agent-backup";
  createdAt: string;
  agentId: string;
  restoreGeneration?: string;
  components: {
    database: AgentBackupDatabaseComponent;
    media: AgentBackupFileSet;
    vault: AgentBackupFileSet;
    character: {
      runtimeCharacter: unknown;
      configFile?: AgentBackupFileEntry;
      sha256: string;
    };
    stateFiles: AgentBackupFileSet;
  };
  integrity: {
    componentHashes: Record<string, string>;
  };
}
