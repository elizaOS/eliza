import type { ReactElement } from "react";
import { useState } from "react";

/**
 * Minimal DocumentsView placeholder.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts and related
 * lifeops UI surfaces). The richer UI (live document list, semantic search
 * results, signature-queue triage drawer) will be ported in a follow-up pass.
 * For now this renders the documents header + three section placeholders so
 * the view registers, mounts, and is visually identifiable.
 */

type SectionId = "recent" | "search" | "signature-queue";

const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  {
    id: "recent",
    label: "Recent",
    description: "Recently ingested or modified documents.",
  },
  {
    id: "search",
    label: "Search",
    description: "Semantic + keyword search across the document store.",
  },
  {
    id: "signature-queue",
    label: "Signature Queue",
    description: "Owner-gated signature and approval requests awaiting action.",
  },
];

export interface DocumentsViewProps {
  initialSection?: SectionId;
}

export function DocumentsView(props: DocumentsViewProps): ReactElement {
  const [activeSection, setActiveSection] = useState<SectionId>(
    props.initialSection ?? "recent",
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          Documents
        </h1>
        <p style={{ color: "#888", margin: 0 }}>
          Browse, search, and triage owner-gated document requests.
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="Documents sections"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
      >
        {SECTIONS.map((section) => {
          const active = section.id === activeSection;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveSection(section.id)}
              style={{
                padding: "0.35rem 0.75rem",
                borderRadius: 999,
                border: "1px solid",
                borderColor: active ? "#f97316" : "#444",
                background: active ? "#f97316" : "transparent",
                color: active ? "#fff" : "inherit",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              {section.label}
            </button>
          );
        })}
      </nav>

      {SECTIONS.map((section) => {
        if (section.id !== activeSection) return null;
        return (
          <section
            key={section.id}
            aria-label={section.label}
            role="tabpanel"
            style={{
              flex: 1,
              border: "1px dashed #333",
              borderRadius: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              color: "#888",
              padding: "1rem",
              gap: "0.5rem",
            }}
          >
            <strong style={{ fontSize: "1rem", color: "#ccc" }}>
              {section.label}
            </strong>
            <span style={{ fontSize: "0.85rem" }}>{section.description}</span>
            <span style={{ fontSize: "0.75rem", color: "#666" }}>
              Placeholder — full UI will be ported from plugin-lifeops.
            </span>
          </section>
        );
      })}
    </div>
  );
}

export default DocumentsView;
