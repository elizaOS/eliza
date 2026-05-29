import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import { Story } from "./Story.tsx";
import "./stories.css";
import { voiceStories } from "./stories/voice.tsx";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <StrictMode>
    <main className="gallery-main">
      <header className="gallery-hero">
        <h1>VoiceWaveform — isolated</h1>
        <p>WebGPU orb, rendered without the (currently broken) catalog App.</p>
      </header>
      <section className="gallery-group">
        {voiceStories.map((s) => (
          <Story key={s.id} story={s} />
        ))}
      </section>
    </main>
  </StrictMode>,
);
