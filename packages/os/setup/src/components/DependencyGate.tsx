import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DependencyCheckResult,
  DependencyId,
} from "../dependencies/types";
import { getServerUrl } from "../runtime/server-url";

const SERVER = getServerUrl();

const DEP_LABELS: Record<DependencyId, string> = {
  adb: "Android Debug Bridge (adb)",
  fastboot: "Fastboot",
  libimobiledevice: "libimobiledevice (iOS detection)",
  sideloader: "Sideloader (iOS app install)",
};

// Android deps are required; iOS deps are optional
const REQUIRED_FOR_CONTINUE: DependencyId[] = ["adb", "fastboot"];

function statusIcon(status: DependencyCheckResult["status"]): string {
  switch (status) {
    case "checking":
      return "⏳";
    case "found":
      return "✅";
    case "found-but-misconfigured":
      return "⚠️";
    case "missing":
      return "❌";
    case "installing":
      return "⏳";
    case "install-failed":
      return "❌";
  }
}

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    backgroundColor: "#0a0a0a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
    color: "#ffffff",
    zIndex: 9999,
  },
  card: {
    backgroundColor: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "12px",
    padding: "32px",
    width: "480px",
    maxWidth: "90vw",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  },
  title: {
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: "8px",
    color: "#ffffff",
  },
  subtitle: {
    fontSize: "13px",
    color: "#888",
    marginBottom: "24px",
  },
  depRow: {
    display: "flex" as const,
    alignItems: "flex-start" as const,
    gap: "12px",
    padding: "12px 0",
    borderBottom: "1px solid #222",
  },
  depIcon: {
    fontSize: "16px",
    lineHeight: "20px",
    flexShrink: 0,
  },
  depInfo: {
    flex: 1,
    minWidth: 0,
  },
  depName: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#e0e0e0",
  },
  depStatus: {
    fontSize: "12px",
    color: "#666",
    marginTop: "2px",
  },
  depVersion: {
    fontSize: "11px",
    color: "#00ff88",
    marginTop: "2px",
    fontFamily: "monospace",
  },
  depActions: {
    flexShrink: 0,
  },
  installBtn: {
    backgroundColor: "#00ff88",
    color: "#000000",
    border: "none",
    borderRadius: "6px",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.15s",
  },
  installBtnDisabled: {
    backgroundColor: "#2a2a2a",
    color: "#555",
    border: "none",
    borderRadius: "6px",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "not-allowed",
  },
  installingText: {
    fontSize: "12px",
    color: "#00ff88",
  },
  details: {
    marginTop: "8px",
    backgroundColor: "#111",
    borderRadius: "6px",
    overflow: "hidden" as const,
  },
  detailsSummary: {
    padding: "8px 12px",
    fontSize: "12px",
    color: "#888",
    cursor: "pointer",
    userSelect: "none" as const,
  },
  detailsBody: {
    padding: "8px 12px 12px",
  },
  manualTitle: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#e0e0e0",
    marginBottom: "6px",
  },
  manualStep: {
    fontSize: "12px",
    color: "#aaa",
    lineHeight: "1.6",
    paddingLeft: "16px",
  },
  manualLink: {
    fontSize: "11px",
    color: "#00ff88",
    marginTop: "6px",
    wordBreak: "break-all" as const,
  },
  footer: {
    marginTop: "24px",
    display: "flex" as const,
    flexDirection: "column" as const,
    gap: "8px",
  },
  continueBtn: {
    backgroundColor: "#00ff88",
    color: "#000000",
    border: "none",
    borderRadius: "8px",
    padding: "12px",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    width: "100%",
    transition: "opacity 0.15s",
  },
  continueBtnDisabled: {
    backgroundColor: "#1e1e1e",
    color: "#444",
    border: "1px solid #2a2a2a",
    borderRadius: "8px",
    padding: "12px",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "not-allowed",
    width: "100%",
  },
  continueBtnWarning: {
    backgroundColor: "#ff6b00",
    color: "#ffffff",
    border: "none",
    borderRadius: "8px",
    padding: "12px",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    width: "100%",
  },
  warningText: {
    fontSize: "12px",
    color: "#ff8844",
    textAlign: "center" as const,
  },
};

interface Props {
  onReady: () => void;
}

export function DependencyGate({ onReady }: Props) {
  const [results, setResults] = useState<DependencyCheckResult[]>([]);
  const [checking, setChecking] = useState(true);
  const [bypassWarning, setBypassWarning] = useState(false);
  const [bypassConfirmCount, setBypassConfirmCount] = useState(0);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const fetchDependencies = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(`${SERVER}/dependencies`);
      const data = (await res.json()) as DependencyCheckResult[];
      setResults(data);
    } catch {
      // Server not reachable — show all as missing
      setResults([
        { id: "adb", status: "missing" },
        { id: "fastboot", status: "missing" },
        { id: "libimobiledevice", status: "missing" },
        { id: "sideloader", status: "missing" },
      ]);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void fetchDependencies();
  }, [fetchDependencies]);

  // Auto-advance when all required deps are found
  useEffect(() => {
    if (checking || results.length === 0) return;
    const allRequired = REQUIRED_FOR_CONTINUE.every((id) =>
      results.some((r) => r.id === id && r.status === "found"),
    );
    if (allRequired) {
      onReadyRef.current();
    }
  }, [results, checking]);

  const handleInstall = useCallback(async (id: DependencyId) => {
    setResults((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, status: "installing" as const } : r,
      ),
    );
    try {
      const res = await fetch(`${SERVER}/dependencies/${id}/install`, {
        method: "POST",
      });
      const updated = (await res.json()) as DependencyCheckResult;
      setResults((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch {
      setResults((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                status: "install-failed" as const,
                errorMessage: "Failed to reach server",
              }
            : r,
        ),
      );
    }
  }, []);

  const requiredFound = REQUIRED_FOR_CONTINUE.every((id) =>
    results.some((r) => r.id === id && r.status === "found"),
  );

  const handleContinue = useCallback(() => {
    if (requiredFound) {
      onReadyRef.current();
      return;
    }
    if (!bypassWarning) {
      setBypassWarning(true);
      setBypassConfirmCount(1);
      return;
    }
    if (bypassConfirmCount < 2) {
      setBypassConfirmCount((n) => n + 1);
      return;
    }
    onReadyRef.current();
  }, [requiredFound, bypassWarning, bypassConfirmCount]);

  const depIds: DependencyId[] = [
    "adb",
    "fastboot",
    "libimobiledevice",
    "sideloader",
  ];
  // Show checking rows while loading.
  const displayResults: DependencyCheckResult[] =
    checking && results.length === 0
      ? depIds.map((id) => ({ id, status: "checking" as const }))
      : depIds.map(
          (id) =>
            results.find((r) => r.id === id) ?? {
              id,
              status: "checking" as const,
            },
        );

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.title}>Setting up dependencies…</div>
        <div style={styles.subtitle}>
          AOSP Flasher requires these tools to detect and flash devices.
        </div>

        {displayResults.map((dep) => (
          <div key={dep.id} style={styles.depRow}>
            <div style={styles.depIcon}>{statusIcon(dep.status)}</div>
            <div style={styles.depInfo}>
              <div style={styles.depName}>{DEP_LABELS[dep.id]}</div>
              {dep.status === "found" && dep.version && (
                <div style={styles.depVersion}>{dep.version}</div>
              )}
              {dep.status === "found" && dep.foundPath && !dep.version && (
                <div style={styles.depVersion}>{dep.foundPath}</div>
              )}
              {dep.status === "missing" && (
                <div style={styles.depStatus}>Not found on this system</div>
              )}
              {dep.status === "found-but-misconfigured" && (
                <div style={styles.depStatus}>
                  {dep.errorMessage ??
                    "Found on system but reported an error when probed"}
                </div>
              )}
              {dep.status === "installing" && (
                <div style={styles.depStatus}>Installing…</div>
              )}
              {dep.status === "install-failed" && (
                <div style={styles.depStatus}>
                  {dep.errorMessage ?? "Installation failed"}
                </div>
              )}
              {dep.status === "install-failed" && dep.manualInstructions && (
                <details style={styles.details}>
                  <summary style={styles.detailsSummary}>
                    Show manual install steps
                  </summary>
                  <div style={styles.detailsBody}>
                    <div style={styles.manualTitle}>
                      {dep.manualInstructions.title}
                    </div>
                    <ol style={{ margin: 0, padding: "0 0 0 16px" }}>
                      {dep.manualInstructions.steps.map((step) => (
                        <li key={step} style={styles.manualStep}>
                          {step}
                        </li>
                      ))}
                    </ol>
                    <div style={styles.manualLink}>
                      {dep.manualInstructions.url}
                    </div>
                  </div>
                </details>
              )}
            </div>
            <div style={styles.depActions}>
              {dep.status === "missing" && (
                <button
                  type="button"
                  style={styles.installBtn}
                  onClick={() => void handleInstall(dep.id)}
                >
                  Auto-install
                </button>
              )}
              {dep.status === "installing" && (
                <span style={styles.installingText}>Installing…</span>
              )}
              {dep.status === "install-failed" && (
                <button
                  type="button"
                  style={styles.installBtn}
                  onClick={() => void handleInstall(dep.id)}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        ))}

        <div style={styles.footer}>
          {bypassWarning && !requiredFound && (
            <div style={styles.warningText}>
              adb and fastboot are required for Android flashing. Continue
              anyway?
            </div>
          )}
          <button
            type="button"
            style={
              requiredFound
                ? styles.continueBtn
                : bypassWarning
                  ? styles.continueBtnWarning
                  : styles.continueBtnDisabled
            }
            onClick={handleContinue}
            disabled={
              !requiredFound &&
              bypassConfirmCount < 2 &&
              bypassWarning &&
              bypassConfirmCount < 1
            }
          >
            {requiredFound
              ? "Continue"
              : bypassWarning && bypassConfirmCount >= 2
                ? "Continue anyway (limited functionality)"
                : bypassWarning
                  ? "Click again to confirm bypass"
                  : "Continue anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
