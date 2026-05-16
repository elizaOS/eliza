declare module "canvas-confetti" {
  namespace confetti {
    type Options = {
      angle?: number;
      colors?: string[];
      decay?: number;
      disableForReducedMotion?: boolean;
      drift?: number;
      gravity?: number;
      origin?: {
        x?: number;
        y?: number;
      };
      particleCount?: number;
      scalar?: number;
      shapes?: string[];
      spread?: number;
      startVelocity?: number;
      ticks?: number;
      zIndex?: number;
    };
  }

  type Confetti = (options?: confetti.Options) => Promise<null> | null;

  const confetti: Confetti;
  export default confetti;
}
