export interface DeviceSpeechState {
  speaking: boolean;
  error: "unavailable" | "playback" | null;
}
export interface DeviceSpeechEnvironment {
  synthesis: Pick<SpeechSynthesis, "speak" | "cancel">;
  utterance: (text: string) => SpeechSynthesisUtterance;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >;
}
function browserEnvironment(): DeviceSpeechEnvironment | null {
  if (
    typeof window === "undefined" ||
    !window.speechSynthesis ||
    typeof SpeechSynthesisUtterance === "undefined"
  )
    return null;
  return {
    synthesis: window.speechSynthesis,
    utterance: (text) => new SpeechSynthesisUtterance(text),
    window,
    document,
  };
}
/** Device speech lifecycle only; hosts supply wording, language, pace and gestures. */
export class DeviceSpeechController {
  private environment: DeviceSpeechEnvironment | null;
  private changed: (state: DeviceSpeechState) => void;
  private state: DeviceSpeechState = { speaking: false, error: null };
  private generation = 0;
  private disposed = false;
  private current: SpeechSynthesisUtterance | null = null;
  private hidden = () => {
    if (this.environment?.document.hidden) this.stop();
  };
  private leaving = () => this.stop();
  constructor(
    changed: (state: DeviceSpeechState) => void,
    environment: DeviceSpeechEnvironment | null = browserEnvironment(),
  ) {
    this.changed = changed;
    this.environment = environment;
    environment?.document.addEventListener("visibilitychange", this.hidden);
    environment?.window.addEventListener("pagehide", this.leaving);
  }
  private publish(state: DeviceSpeechState) {
    this.state = state;
    if (!this.disposed) this.changed({ ...state });
  }
  stop(): void {
    ++this.generation;
    if (this.current) {
      this.current.onend = null;
      this.current.onerror = null;
      this.current = null;
    }
    let error = this.state.error;
    try {
      this.environment?.synthesis.cancel();
    } catch {
      error = "playback";
    }
    this.publish({ speaking: false, error });
  }
  speak(text: string, language: string, rate: number): void {
    if (this.disposed) return;
    this.stop();
    const ticket = this.generation;
    if (!this.environment) {
      this.publish({ speaking: false, error: "unavailable" });
      return;
    }
    try {
      const utterance = this.environment.utterance(text);
      this.current = utterance;
      utterance.lang = language;
      utterance.rate = rate;
      const finish = (error: DeviceSpeechState["error"]) => {
        if (ticket !== this.generation || this.disposed) return;
        ++this.generation;
        utterance.onend = null;
        utterance.onerror = null;
        this.current = null;
        this.publish({ speaking: false, error });
      };
      utterance.onend = () => finish(null);
      utterance.onerror = () => finish("playback");
      this.publish({ speaking: true, error: null });
      if (ticket === this.generation && !this.disposed)
        this.environment.synthesis.speak(utterance);
    } catch {
      if (ticket === this.generation) {
        this.stop();
        this.publish({ speaking: false, error: "playback" });
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.environment?.document.removeEventListener(
      "visibilitychange",
      this.hidden,
    );
    this.environment?.window.removeEventListener("pagehide", this.leaving);
  }
}
