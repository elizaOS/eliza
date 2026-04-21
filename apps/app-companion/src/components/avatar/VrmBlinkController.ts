/** Blink animation phase */
type BlinkPhase = "idle" | "closing" | "closed" | "opening";

/**
 * Self-contained blink state machine for VRM eye-blink animation.
 *
 * State flow: idle -> closing -> closed -> opening -> idle
 * Random interval between blinks with occasional double-blinks.
 */
export class VrmBlinkController {
  private blinkPhase: BlinkPhase = "idle";
  private blinkTimer = 0;
  private blinkPhaseTimer = 0;
  private _blinkValue = 0;
  private nextBlinkDelay = 2 + Math.random() * 3;

  /** Duration (seconds) for eyelids to close */
  private static readonly BLINK_CLOSE_DURATION = 0.06;
  /** Duration (seconds) eyelids stay fully closed */
  private static readonly BLINK_HOLD_DURATION = 0.04;
  /** Duration (seconds) for eyelids to re-open */
  private static readonly BLINK_OPEN_DURATION = 0.12;
  /** Minimum seconds between blinks */
  private static readonly BLINK_MIN_INTERVAL = 1.8;
  /** Maximum seconds between blinks */
  private static readonly BLINK_MAX_INTERVAL = 5.5;
  /** Probability of a quick double-blink */
  private static readonly DOUBLE_BLINK_CHANCE = 0.15;

  /** Current blink expression weight (0 = open, 1 = closed). */
  get blinkValue(): number {
    return this._blinkValue;
  }

  /**
   * Advance the blink state machine by `delta` seconds.
   * Returns the current blink expression weight (0..1).
   */
  update(delta: number): number {
    switch (this.blinkPhase) {
      case "idle":
        this.blinkTimer += delta;
        if (this.blinkTimer >= this.nextBlinkDelay) {
          this.blinkPhase = "closing";
          this.blinkPhaseTimer = 0;
        }
        break;

      case "closing": {
        this.blinkPhaseTimer += delta;
        const t = Math.min(
          1,
          this.blinkPhaseTimer / VrmBlinkController.BLINK_CLOSE_DURATION,
        );
        // Ease-in (accelerate) — eyelids speed up as they close
        this._blinkValue = t * t;
        if (t >= 1) {
          this.blinkPhase = "closed";
          this.blinkPhaseTimer = 0;
          this._blinkValue = 1;
        }
        break;
      }

      case "closed":
        this.blinkPhaseTimer += delta;
        if (this.blinkPhaseTimer >= VrmBlinkController.BLINK_HOLD_DURATION) {
          this.blinkPhase = "opening";
          this.blinkPhaseTimer = 0;
        }
        break;

      case "opening": {
        this.blinkPhaseTimer += delta;
        const t = Math.min(
          1,
          this.blinkPhaseTimer / VrmBlinkController.BLINK_OPEN_DURATION,
        );
        // Ease-out (decelerate) — eyelids slow down as they finish opening
        const eased = 1 - (1 - t) * (1 - t);
        this._blinkValue = 1 - eased;
        if (t >= 1) {
          this.blinkPhase = "idle";
          this.blinkPhaseTimer = 0;
          this._blinkValue = 0;
          this.blinkTimer = 0;
          this.scheduleNextBlink();
        }
        break;
      }
    }

    return this._blinkValue;
  }

  /** Reset blink state (called when a new VRM is loaded). */
  reset(): void {
    this.blinkPhase = "idle";
    this.blinkTimer = 0;
    this.blinkPhaseTimer = 0;
    this._blinkValue = 0;
    this.nextBlinkDelay = 1.5 + Math.random() * 2;
  }

  /** Pick the delay (seconds) until the next blink. */
  private scheduleNextBlink(): void {
    const range =
      VrmBlinkController.BLINK_MAX_INTERVAL -
      VrmBlinkController.BLINK_MIN_INTERVAL;
    this.nextBlinkDelay =
      VrmBlinkController.BLINK_MIN_INTERVAL + Math.random() * range;

    // Occasional quick double-blink
    if (Math.random() < VrmBlinkController.DOUBLE_BLINK_CHANCE) {
      this.nextBlinkDelay = 0.12 + Math.random() * 0.08;
    }
  }
}
