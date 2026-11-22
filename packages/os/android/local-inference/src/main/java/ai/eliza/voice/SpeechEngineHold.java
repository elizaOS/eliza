package ai.eliza.voice;

/**
 * A conversation's hold on the loaded speech engine: while held in the foreground, the idle timer
 * does not unload it. One flag, not a count: holding twice is holding once. Pause and memory trim
 * end the hold ({@link #release}); they unload on their own schedule.
 */
public final class SpeechEngineHold {
 private boolean held;
 public synchronized void hold(){held=true;}
 /** True when a hold ended: the host re-arms its idle timer. */
 public synchronized boolean release(){boolean was=held;held=false;return was;}
 /** The idle timer fired: true keeps the engine loaded. */
 public synchronized boolean keeps(boolean foreground){return held&&foreground;}
}
