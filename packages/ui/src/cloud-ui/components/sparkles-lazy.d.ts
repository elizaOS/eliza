/**
 * Lazy-loaded wrapper for SparklesCore component.
 * Dynamically imports @tsparticles (~400KB) only when needed.
 */
import type { ParticlesProps } from "./sparkles";

declare const SparklesCore: import("react").ComponentType<ParticlesProps>;

export { SparklesCore };
//# sourceMappingURL=sparkles-lazy.d.ts.map
