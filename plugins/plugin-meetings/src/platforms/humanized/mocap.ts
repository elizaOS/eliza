/**
 * Clean-room procedural mocap library + selection engine (Apache-2.0).
 *
 * Trajectories are generated from a seeded min-jerk (smoothstep-velocity)
 * motion model — not derived from any third-party recording or source. The
 * engine picks a trajectory whose cumulative displacement lands the pointer
 * inside a target rect, expanding the base library with small rotational
 * perturbations and falling back to a stretch+rotate fit when nothing lands
 * directly.
 */

import type {
  MocapLibrary,
  MocapMovement,
  MocapSequence,
  Rect,
} from "./types.js";

/** Deterministic small PRNG (mulberry32) so generation + selection are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate one min-jerk trajectory covering `dist` px along `angleDeg`, with
 * per-step jitter. Steps follow the min-jerk velocity profile
 * v(s) ∝ 30s²(1-s)² so the pointer eases in and out like a human reach.
 */
function generateSequence(
  dist: number,
  angleDeg: number,
  steps: number,
  rng: () => number,
): MocapSequence {
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // Perpendicular unit vector for lateral wobble.
  const px = -uy;
  const py = ux;

  const movements: MocapMovement[] = [];
  let prevX = 0;
  let prevY = 0;
  let totalDx = 0;
  let totalDy = 0;

  for (let i = 1; i <= steps; i++) {
    const s = i / steps;
    // Min-jerk position profile: 6s^5 - 15s^4 + 10s^3.
    const posFrac = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5;
    const along = posFrac * dist;
    // Lateral wobble that decays toward the target.
    const wobble = (rng() - 0.5) * 4 * (1 - s);
    const curX = ux * along + px * wobble;
    const curY = uy * along + py * wobble;
    const dx = Math.round(curX - prevX);
    const dy = Math.round(curY - prevY);
    prevX += dx;
    prevY += dy;
    totalDx += dx;
    totalDy += dy;
    // Dwell inversely proportional to velocity (slower at the ends). The raw
    // profile 30s²(1-s)² peaks at 1.875 (s=0.5); normalize to [0,1] so dt stays
    // positive.
    const velFrac = (30 * s ** 2 * (1 - s) ** 2) / 1.875;
    const dt = 0.006 + 0.02 * (1 - velFrac);
    movements.push({ dx, dy, dt: Number(dt.toFixed(4)) });
  }

  return {
    movements,
    total_dx: totalDx,
    total_dy: totalDy,
    click_down_dt: Number((0.06 + rng() * 0.05).toFixed(4)),
    click_up_dt: Number((0.05 + rng() * 0.05).toFixed(4)),
  };
}

/** Build the default clean-room library: radii × angles, seeded. */
export function buildMocapLibrary(seed = 0x56455841): MocapLibrary {
  const rng = mulberry32(seed);
  const radii = [130, 280, 450, 650, 880, 1130, 1400];
  const angleStep = 15;
  const sequences: MocapSequence[] = [];
  for (const r of radii) {
    for (let angle = 0; angle < 360; angle += angleStep) {
      const steps = Math.max(8, Math.round(r / 12));
      sequences.push(generateSequence(r, angle, steps, rng));
    }
  }
  return {
    meta: {
      generator: "elizaOS clean-room procedural mocap",
      license: "Apache-2.0",
      provenance:
        "Synthetic. Min-jerk motion model, seeded PRNG. Not derived from any third-party recording or source.",
      seed: `0x${seed.toString(16)}`,
      radii,
      angle_step_deg: angleStep,
      count: sequences.length,
    },
    sequences,
  };
}

export const MOCAP_LIBRARY: MocapLibrary = buildMocapLibrary();

function rotateSequence(
  seq: MocapSequence,
  degrees: number,
  scale = 1,
): MocapSequence {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let totalDx = 0;
  let totalDy = 0;
  const movements: MocapMovement[] = seq.movements.map((m) => {
    const sx = m.dx * scale;
    const sy = m.dy * scale;
    const ndx = Math.round(sx * cos - sy * sin);
    const ndy = Math.round(sx * sin + sy * cos);
    totalDx += ndx;
    totalDy += ndy;
    return { dx: ndx, dy: ndy, dt: m.dt };
  });
  return {
    movements,
    total_dx: totalDx,
    total_dy: totalDy,
    click_down_dt: seq.click_down_dt,
    click_up_dt: seq.click_up_dt,
  };
}

export class MocapEngine {
  private readonly sequences: MocapSequence[] = [];
  private readonly rng: () => number;

  constructor(library: MocapLibrary = MOCAP_LIBRARY, seed = 0x56455841) {
    this.rng = mulberry32(seed);
    const base = library.sequences;
    this.sequences = [...base];
    // Expand with small rotational perturbations to multiply landing points.
    const perturbSteps = 6;
    for (const seq of base) {
      for (let i = 1; i <= perturbSteps; i++) {
        const angle = -5 + (10 / (perturbSteps + 1)) * i;
        if (Math.abs(angle) < 1e-6) continue;
        this.sequences.push(rotateSequence(seq, angle));
      }
    }
  }

  get size(): number {
    return this.sequences.length;
  }

  private landsIn(
    seq: MocapSequence,
    x: number,
    y: number,
    rect: Rect,
  ): boolean {
    const fx = x + seq.total_dx;
    const fy = y + seq.total_dy;
    return (
      fx >= rect.left && fx <= rect.right && fy >= rect.top && fy <= rect.bottom
    );
  }

  /** Pick a random sequence whose endpoint lands inside `rect`; null if none. */
  findSequenceLandingInRect(
    x: number,
    y: number,
    rect: Rect,
  ): MocapSequence | null {
    const matching = this.sequences.filter((s) => this.landsIn(s, x, y, rect));
    if (matching.length === 0) return null;
    return matching[Math.floor(this.rng() * matching.length)];
  }

  /** Fallback: scale+rotate a base sequence to land on the rect center. */
  findSequenceWithStretchAndRotation(
    x: number,
    y: number,
    rect: Rect,
  ): MocapSequence | null {
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const wantDx = cx - x;
    const wantDy = cy - y;
    const wantDist = Math.hypot(wantDx, wantDy);
    const wantAngle = Math.atan2(wantDy, wantDx);

    let best: MocapSequence | null = null;
    let bestScaleDev = Infinity;
    for (const seq of this.sequences) {
      const seqDist = Math.hypot(seq.total_dx, seq.total_dy);
      if (seqDist < 1) continue;
      const seqAngle = Math.atan2(seq.total_dy, seq.total_dx);
      const scale = wantDist / seqDist;
      if (scale < 0.4 || scale > 2.6) continue;
      const rotDeg = ((wantAngle - seqAngle) * 180) / Math.PI;
      if (Math.abs(rotDeg) > 35) continue;
      const scaleDev = Math.abs(Math.log(scale));
      if (scaleDev < bestScaleDev) {
        const candidate = rotateSequence(seq, rotDeg, scale);
        if (this.landsIn(candidate, x, y, rect)) {
          best = candidate;
          bestScaleDev = scaleDev;
        }
      }
    }
    return best;
  }
}
