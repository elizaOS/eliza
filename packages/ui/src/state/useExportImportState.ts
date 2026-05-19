/**
 * Agent export/import state — extracted from AppContext.
 *
 * Manages the export/import UI state and the download/upload
 * callbacks. Uses the client singleton directly, matching the
 * pattern of useTriggersState / usePairingState.
 */

import { useCallback, useRef, useState } from "react";
import { client } from "../api";
import { AGENT_TRANSFER_MIN_PASSWORD_LENGTH } from "./internal";

export function useExportImportState() {
  // ── Export ─────────────────────────────────────────────────────────
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportIncludeLogs, setExportIncludeLogs] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  // ── Import ─────────────────────────────────────────────────────────
  const [importBusy, setImportBusy] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  /** Synchronous lock for export action to prevent duplicate clicks in the same tick. */
  const exportBusyRef = useRef(false);
  /** Synchronous lock for import action to prevent duplicate clicks in the same tick. */
  const importBusyRef = useRef(false);

  // ── Callbacks ──────────────────────────────────────────────────────

  const handleAgentExport = useCallback(async () => {
    if (exportBusyRef.current || exportBusy) return;
    if (!exportPassword) {
      setExportError("Password is required.");
      setExportSuccess(null);
      return;
    }
    if (exportPassword.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      setExportError(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
      setExportSuccess(null);
      return;
    }
    try {
      exportBusyRef.current = true;
      setExportBusy(true);
      setExportError(null);
      setExportSuccess(null);
      const resp = await client.exportAgent(exportPassword, exportIncludeLogs);
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") ?? "";
      const filenameMatch = /filename="?([^"]+)"?/.exec(disposition);
      const filename = filenameMatch?.[1] ?? "agent-export.eliza-agent";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportSuccess(
        `Exported successfully (${(blob.size / 1024).toFixed(0)} KB)`,
      );
      setExportPassword("");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      exportBusyRef.current = false;
      setExportBusy(false);
    }
  }, [exportBusy, exportPassword, exportIncludeLogs]);

  const handleAgentImport = useCallback(async () => {
    if (importBusyRef.current || importBusy) return;
    if (!importFile) {
      setImportError("Select an export file before importing.");
      setImportSuccess(null);
      return;
    }
    if (!importPassword) {
      setImportError("Password is required.");
      setImportSuccess(null);
      return;
    }
    if (importPassword.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      setImportError(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
      setImportSuccess(null);
      return;
    }
    try {
      importBusyRef.current = true;
      setImportBusy(true);
      setImportError(null);
      setImportSuccess(null);
      const fileBuffer = await importFile.arrayBuffer();
      const result = await client.importAgent(importPassword, fileBuffer);
      const counts = result.counts;
      const summary = [
        counts.memories ? `${counts.memories} memories` : null,
        counts.entities ? `${counts.entities} entities` : null,
        counts.rooms ? `${counts.rooms} rooms` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setImportSuccess(
        `Imported "${result.agentName}" successfully: ${summary || "no data"}. Restart the agent to activate.`,
      );
      setImportPassword("");
      setImportFile(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  }, [importBusy, importFile, importPassword]);

  return {
    state: {
      exportBusy,
      exportPassword,
      exportIncludeLogs,
      exportError,
      exportSuccess,
      importBusy,
      importPassword,
      importFile,
      importError,
      importSuccess,
    },
    setExportPassword,
    setExportIncludeLogs,
    setExportError,
    setExportSuccess,
    setImportPassword,
    setImportFile,
    setImportError,
    setImportSuccess,
    handleAgentExport,
    handleAgentImport,
  };
}
