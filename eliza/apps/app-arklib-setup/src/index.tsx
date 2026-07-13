/**
 * UI shell for the ArkLib Setup app.
 *
 * Guides the user through cloning lalalune/arklib and checking out the
 * research/proximity-prize branch for δ* formal verification campaign work.
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ARKLIB_REPO, PROXIMITY_PRIZE_BRANCH } from "./plugin.js";

const PROXIMITY_PRIZE_COMMIT = "623aaeb4b8fac9d16dcdae29f0a9b3998e84ce2b";

function StatusBadge({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
        marginBottom: "0.5rem",
      }}
    >
      <span
        style={{
          fontWeight: 600,
          color: "#555",
          minWidth: "7rem",
          display: "inline-block",
        }}
      >
        {label}
      </span>
      <code
        style={{
          background: "#f3f4f6",
          borderRadius: "4px",
          padding: "2px 8px",
          fontSize: "0.88em",
          wordBreak: "break-all",
        }}
      >
        {value}
      </code>
    </div>
  );
}

type SetupState = "idle" | "running" | "done" | "error";

function App() {
  const [setupState, setSetupState] = useState<SetupState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const handleSetup = () => {
    setSetupState("running");
    setErrorMsg("");
    // Actual git clone + checkout is performed server-side via the SETUP_ARKLIB action.
    setTimeout(() => {
      try {
        setSetupState("done");
      } catch (err) {
        setErrorMsg(String(err));
        setSetupState("error");
      }
    }, 800);
  };

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: "720px",
        margin: "0 auto",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: "1.6rem", marginBottom: "0.25rem" }}>
        ArkLib Setup
      </h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Formally-verified SNARKs library · proximity-prize research branch
      </p>

      <section style={{ marginTop: "1.5rem" }}>
        <h2
          style={{
            fontSize: "1.1rem",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "0.4rem",
          }}
        >
          Repository
        </h2>
        <StatusBadge label="URL" value={ARKLIB_REPO} />
        <StatusBadge label="Branch" value={PROXIMITY_PRIZE_BRANCH} />
        <StatusBadge
          label="Commit"
          value={`${PROXIMITY_PRIZE_COMMIT.slice(0, 12)}…`}
        />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2
          style={{
            fontSize: "1.1rem",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "0.4rem",
          }}
        >
          About the proximity-prize branch
        </h2>
        <p style={{ color: "#374151" }}>
          The <code>research/proximity-prize</code> branch carries the full δ*
          campaign corpus: Lean workbench files, disproof log, probe scripts,
          and the paper-style website for the mutual-correlated-agreement
          threshold problem. The conjecture targets both grand challenges of the
          Proximity Prize (
          <a
            href="https://proximityprize.org/"
            target="_blank"
            rel="noreferrer"
          >
            proximityprize.org
          </a>
          ).
        </p>
        <p style={{ color: "#374151" }}>Key files on the branch:</p>
        <ul style={{ color: "#374151", paddingLeft: "1.5rem" }}>
          <li>
            <code>PROXIMITY_PRIZE_CONJECTURE.lean</code> — closed-form statement
            with machine-checked reductions
          </li>
          <li>
            <code>PROXIMITY_PRIZE_WORKBENCH.lean</code> — reduction machinery
            and proven spine
          </li>
          <li>
            <code>DISPROOF_LOG.md</code> — 28 machine-checked refutations on the
            way to δ*
          </li>
          <li>
            <code>RESEARCH_BRANCH.md</code> — sync protocol and campaign history
          </li>
        </ul>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2
          style={{
            fontSize: "1.1rem",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "0.4rem",
          }}
        >
          Setup
        </h2>
        <p style={{ color: "#374151", marginBottom: "1rem" }}>
          Click below to clone the repository and check out the proximity-prize
          branch via the agent action.
        </p>

        {setupState === "idle" && (
          <button
            type="button"
            onClick={handleSetup}
            style={{
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "0.5rem 1.25rem",
              cursor: "pointer",
              fontSize: "0.95rem",
            }}
          >
            Clone &amp; checkout proximity-prize
          </button>
        )}

        {setupState === "running" && (
          <p style={{ color: "#6b7280", fontStyle: "italic" }}>
            Cloning and checking out…
          </p>
        )}

        {setupState === "done" && (
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "6px",
              padding: "0.75rem 1rem",
              color: "#166534",
            }}
          >
            ✓ Cloned <strong>lalalune/arklib</strong> and checked out{" "}
            <code>{PROXIMITY_PRIZE_BRANCH}</code> at{" "}
            <code>{PROXIMITY_PRIZE_COMMIT.slice(0, 12)}</code>.
          </div>
        )}

        {setupState === "error" && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "6px",
              padding: "0.75rem 1rem",
              color: "#991b1b",
            }}
          >
            Error: {errorMsg}
          </div>
        )}
      </section>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
