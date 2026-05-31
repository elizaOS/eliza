import { useState } from "react";
import { FaceRig } from "./FaceRig";
import { EMOTIONS, type RigEmotion } from "./rigRuntime";

/**
 * Structural match of the gallery's `StoryDefinition` (stories/src/Story.tsx).
 * Declared locally so this file stays dependency-free and can be dropped into
 * the catalog with a one-line import + spread in `stories/src/App.tsx`:
 *
 *   import { faceRigStories } from "@ui-src/homescreen/face-rig/FaceRig.stories";
 *   // …then add a group: { id: "face-rig", title: "Face Rig", stories: faceRigStories }
 */
interface FaceRigStory {
  id: string;
  name: string;
  importPath: string;
  description?: string;
  render: () => React.ReactNode;
}

const EMOTION_KEYS = Object.keys(EMOTIONS) as RigEmotion[];

function FaceRigDemo(): React.JSX.Element {
  const [emotion, setEmotion] = useState<RigEmotion>("neutral");
  const [talking, setTalking] = useState(false);
  const [idle, setIdle] = useState(true);
  const [blink, setBlink] = useState(true);

  return (
    <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
      <div
        style={{
          width: 260,
          height: 260,
          background: "#0b0b0f",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <FaceRig
          emotion={emotion}
          talking={talking}
          idle={idle}
          blink={blink}
        />
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          justifyContent: "center",
          maxWidth: 320,
        }}
      >
        {EMOTION_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setEmotion(key)}
            style={chipStyle(key === emotion)}
          >
            {key}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={() => setTalking((v) => !v)}
          style={chipStyle(talking)}
        >
          talking
        </button>
        <button
          type="button"
          onClick={() => setIdle((v) => !v)}
          style={chipStyle(idle)}
        >
          idle
        </button>
        <button
          type="button"
          onClick={() => setBlink((v) => !v)}
          style={chipStyle(blink)}
        >
          blink
        </button>
      </div>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--accent-primary, #ff5800)" : "transparent",
    border: "1px solid var(--border, rgba(255,255,255,0.2))",
    borderRadius: 4,
    color: active ? "#fff" : "inherit",
    cursor: "pointer",
    fontSize: 12,
    padding: "4px 10px",
    textTransform: "capitalize",
  };
}

export const faceRigStories: FaceRigStory[] = [
  {
    id: "face-rig",
    name: "FaceRig (negative-space anime puppet)",
    importPath: 'import { FaceRig } from "@elizaos/ui/homescreen/face-rig"',
    description:
      "Single-color anime face rig on a dark canvas. Switch emotions, toggle the talking jaw envelope, and toggle idle sway / blinks. Renders the baked rest-pose SVG (SSR-safe) and animates it on a single rAF loop; honors prefers-reduced-motion.",
    render: () => <FaceRigDemo />,
  },
];
