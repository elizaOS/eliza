'use client';

import { cn } from '@feed/shared';
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from 'framer-motion';
import { ChevronRight, TrendingDown, Trophy, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const AUTO_DISMISS_MS = 10000;
const PARTICLES_PER_WAVE = 400;
const WAVE_COUNT = 32;
const WAVE_DELAY_S = 0.08;
const FADE_START_S = 2;
const FADE_DURATION_S = 1.5;
const CONFETTI_COLORS = [
  '#0066FF',
  '#22c55e',
  '#eab308',
  '#ef4444',
  '#a855f7',
  '#3b82f6',
];

export interface OutcomeNotification {
  id: string;
  marketId: string;
  marketName: string;
  outcome: 'win' | 'loss';
  points: number;
  agentName?: string;
  deepLink: string;
}

interface OutcomeNotificationPopupProps {
  notification: OutcomeNotification | null;
  onDismiss: () => void;
}

interface Particle {
  // burst target (relative to center)
  bx: number;
  by: number;
  // current position
  x: number;
  y: number;
  // gravity
  fallSpeed: number;
  gravity: number;
  // sway
  swayAmp: number;
  swayFreq: number;
  swayOffset: number;
  // spin
  rotation: number;
  rotSpeed: number;
  // shape
  w: number;
  h: number;
  color: string;
  shape: number; // 0=circle 1=square 2=rect 3=diamond
  // timing
  birthTime: number;
  burstDuration: number;
  burstProgress: number;
  alpha: number;
}

function createWaveParticles(
  cx: number,
  cy: number,
  birthTime: number
): Particle[] {
  return Array.from({ length: PARTICLES_PER_WAVE }, (_, i) => {
    // Full 360 burst but squash vertical range to bias upward
    const angle =
      (Math.PI * 2 * i) / PARTICLES_PER_WAVE + (Math.random() - 0.5) * 1;
    const distance = 20 + Math.random() * 780;
    const size = 6 + Math.random() * 10;
    const shape = i % 4;

    // Reduce horizontal burst, keep some. Boost upward.
    const rawBx = Math.cos(angle) * distance;
    const rawBy = Math.sin(angle) * distance * 0.7 - 200;
    // Squash horizontal by 60%, add horizontal drift so it spreads wide during fall
    const horizontalDrift = Math.cos(angle) * (150 + Math.random() * 250);

    return {
      bx: rawBx * 0.6 + horizontalDrift,
      by: Math.min(rawBy, rawBy * 0.8 - 80),
      x: cx,
      y: cy,
      fallSpeed: 0,
      gravity: 800 + Math.random() * 600,
      swayAmp: 15 + Math.random() * 30,
      swayFreq: 2 + Math.random() * 3,
      swayOffset: Math.random() * Math.PI * 2,
      rotation: 0,
      rotSpeed: (90 + Math.random() * 270) * (Math.random() > 0.5 ? 1 : -1),
      w: shape === 2 ? size * 0.4 : shape === 3 ? size * 0.7 : size,
      h:
        shape === 0
          ? size
          : shape === 1
            ? size * (0.6 + Math.random() * 0.4)
            : shape === 2
              ? size * 0.4
              : size * 0.7,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      shape,
      birthTime,
      burstDuration: 0.3 + Math.random() * 0.1,
      burstProgress: 0,
      alpha: 1,
    };
  });
}

/** Canvas-based confetti — 1 DOM element, all particles via requestAnimationFrame */
export function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size canvas to window
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    const allParticles: Particle[] = [];
    const startTime = performance.now() / 1000;

    // Spawn waves
    for (let w = 0; w < WAVE_COUNT; w++) {
      const waveBirth = w * WAVE_DELAY_S;
      allParticles.push(...createWaveParticles(centerX, centerY, waveBirth));
    }

    let rafId: number;

    const draw = (now: number) => {
      const t = now / 1000 - startTime;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of allParticles) {
        const age = t - p.birthTime;
        if (age < 0) continue; // not born yet

        // Burst phase (ease-out) — update particle state, then compute position
        p.burstProgress = Math.min(age / p.burstDuration, 1);
        const eased = 1 - (1 - p.burstProgress) * (1 - p.burstProgress); // ease-out quad
        const bx = p.x + p.bx * eased;
        const by = p.y + p.by * eased;

        // Gravity — update fall velocity (v = at), compute displacement (d = ½vt)
        const gravityTime = Math.max(age - p.burstDuration * 0.5, 0);
        p.fallSpeed = p.gravity * gravityTime;
        const gravityY = 0.5 * p.fallSpeed * gravityTime;

        // Sway
        const swayX = Math.sin(age * p.swayFreq + p.swayOffset) * p.swayAmp;

        // Final position
        const fx = bx + swayX;
        const fy = by + gravityY;

        // Fade: fully visible until FADE_START_S after birth, then fade
        const fadeAge = age - FADE_START_S;
        if (fadeAge > FADE_DURATION_S) continue; // fully gone
        const alpha = fadeAge <= 0 ? 1 : 1 - fadeAge / FADE_DURATION_S;

        // Rotation
        const rot = (age * p.rotSpeed * Math.PI) / 180;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(fx, fy);
        ctx.rotate(rot);

        ctx.fillStyle = p.color;

        if (p.shape === 0) {
          // Circle
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.shape === 3) {
          // Diamond (rotated 45deg)
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        } else {
          // Square / rectangle
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }

        ctx.restore();
      }

      // Stop when all particles have faded
      const maxLife =
        (WAVE_COUNT - 1) * WAVE_DELAY_S + FADE_START_S + FADE_DURATION_S;
      if (t < maxLife) {
        rafId = requestAnimationFrame(draw);
      }
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 1 }}
    />
  );
}

/** Animated number counter that rolls from 0 to the target value */
function AnimatedPoints({ value, isWin }: { value: number; isWin: boolean }) {
  // Start value should have the same number of digits as the final value
  // e.g. 1250 → start at 1000, 25000 → start at 10000
  const abs = Math.abs(value);
  const digits = abs.toString().length;
  const minStart = digits > 1 ? 10 ** (digits - 1) : 0;
  const startAbs = Math.max(minStart, Math.round(abs * 0.7));
  const startValue = value >= 0 ? startAbs : -startAbs;

  const motionValue = useMotionValue(startValue);
  const rounded = useTransform(motionValue, (v) => {
    const abs = Math.abs(Math.round(v));
    const formatted = abs.toLocaleString('en-US');
    return `${value >= 0 ? '+' : '-'}${formatted}`;
  });
  // Quick scale up, hold, then ease back at the end
  const progress = useTransform(motionValue, [startValue, value], [0, 1]);
  const numberScale = useTransform(progress, (p) => {
    if (!isWin) return 1; // no scale for loss
    if (p < 0.97) return 1.7;
    return 1 + (1 - p) * (70 / 3); // snap back in last 3%
  });
  const spacing = useTransform(progress, (p) => {
    if (!isWin) return 0;
    if (p < 0.97) return 36;
    return (1 - p) * 800; // snap back to 0
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: motionValue is a stable MotionValue reference (useMotionValue behaves like useRef)
  useEffect(() => {
    motionValue.set(startValue);
    const controls = animate(motionValue, value, {
      duration: 3,
      ease: 'easeOut',
      delay: 0.4,
    });
    return controls.stop;
  }, [value]);

  return (
    <div
      className={cn(
        'mb-5 flex items-center justify-center rounded-xl py-3',
        isWin ? 'bg-green-500/10' : 'bg-red-500/5'
      )}
    >
      <span
        className={cn(
          'relative font-bold text-2xl tracking-tight',
          isWin ? 'text-green-500' : 'text-red-500'
        )}
      >
        {/* Invisible placeholder to reserve width for final value */}
        <span className="invisible">
          {value >= 0 ? '+' : '-'}
          {Math.abs(value).toLocaleString('en-US', {
            maximumFractionDigits: 0,
          })}
        </span>
        {/* Animated value overlaid on top */}
        <span className="absolute inset-0 flex items-center justify-center">
          <motion.span style={{ scale: numberScale, display: 'inline-block' }}>
            {rounded}
          </motion.span>
        </span>
      </span>
      <motion.span
        className={cn(
          'font-bold text-2xl tracking-tight',
          isWin ? 'text-green-500' : 'text-red-500'
        )}
        style={{ marginLeft: spacing }}
      >
        &nbsp;pts
      </motion.span>
    </div>
  );
}

export function OutcomeNotificationPopup({
  notification,
  onDismiss,
}: OutcomeNotificationPopupProps) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const startedAtRef = useRef(0);
  const [paused, setPaused] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(
    (ms: number) => {
      clearTimer();
      remainingRef.current = ms;
      startedAtRef.current = Date.now();
      timerRef.current = setTimeout(onDismiss, ms);
    },
    [onDismiss, clearTimer]
  );

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      clearTimer();
    }
    setPaused(true);
  }, [clearTimer]);

  const resumeTimer = useCallback(() => {
    setPaused(false);
    if (!timerRef.current && remainingRef.current > 0) {
      startTimer(remainingRef.current);
    }
  }, [startTimer]);

  useEffect(() => {
    if (!notification) return;

    startTimer(AUTO_DISMISS_MS);

    return clearTimer;
  }, [notification, startTimer, clearTimer]);

  // Lock body scroll when visible
  useEffect(() => {
    if (!notification) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [notification]);

  const handleTap = useCallback(() => {
    if (!notification) return;
    clearTimer();
    onDismiss();
    // Guard against open redirects — deep links must be relative paths
    const safeLink = notification.deepLink.startsWith('/')
      ? notification.deepLink
      : '/';
    router.push(safeLink);
  }, [notification, onDismiss, clearTimer, router]);

  const isWin = notification?.outcome === 'win';

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          key={notification.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[110] flex items-center justify-center"
        >
          {/* Backdrop — tinted by outcome, dismiss only */}
          <div
            className={cn(
              'absolute inset-0 backdrop-blur-md',
              isWin ? 'bg-green-950/20' : 'bg-red-950/5'
            )}
            onClick={onDismiss}
          />

          {/* Win confetti — canvas-based for performance */}
          {isWin && <ConfettiCanvas />}

          {/* Card — win rises up, loss drops down */}
          <motion.div
            onClick={handleTap}
            onMouseEnter={pauseTimer}
            onMouseLeave={resumeTimer}
            initial={{
              scale: 0.85,
              opacity: 0,
              y: isWin ? 60 : -60,
            }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{
              scale: 0.9,
              opacity: 0,
              y: isWin ? -30 : 30,
            }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            className={cn(
              'relative z-10 mx-4 w-full max-w-sm cursor-pointer overflow-hidden rounded-2xl border bg-card shadow-2xl',
              isWin ? 'border-green-500/20' : 'border-border'
            )}
          >
            {/* Close button */}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={(e) => {
                e.stopPropagation();
                clearTimer();
                onDismiss();
              }}
              className="absolute top-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground/40 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Gradient header */}
            <div
              className={cn(
                'relative flex flex-col items-center px-6 pt-8 pb-10',
                isWin
                  ? 'bg-gradient-to-b from-green-500/15 to-transparent'
                  : 'bg-gradient-to-b from-red-500/10 to-transparent'
              )}
            >
              {/* Icon badge with pulsing glow ring (win only) */}
              <div className="relative mb-4">
                {isWin && (
                  <motion.div
                    className="absolute inset-0 rounded-full bg-green-500/20"
                    animate={{
                      scale: [1, 1.6, 1],
                      opacity: [0.4, 0, 0.4],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Number.POSITIVE_INFINITY,
                      ease: 'easeInOut',
                    }}
                  />
                )}
                <motion.div
                  initial={{ scale: 0, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{
                    type: 'spring',
                    damping: 12,
                    stiffness: 200,
                    delay: 0.15,
                  }}
                  className={cn(
                    'relative flex h-16 w-16 items-center justify-center rounded-full',
                    isWin
                      ? 'bg-green-500/15 ring-2 ring-green-500/30'
                      : 'bg-red-500/10 ring-2 ring-red-500/20'
                  )}
                >
                  {isWin ? (
                    <Trophy className="h-8 w-8 text-green-500" />
                  ) : (
                    <TrendingDown className="h-8 w-8 text-red-500" />
                  )}
                </motion.div>
              </div>

              {/* Outcome label */}
              <motion.h2
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.3 }}
                className={cn(
                  'font-bold text-2xl',
                  isWin ? 'text-green-500' : 'text-red-500'
                )}
              >
                {isWin ? 'You Won!' : 'You Lost'}
              </motion.h2>

              {/* Agent attribution */}
              {notification.agentName && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3, duration: 0.3 }}
                  className="mt-1 text-muted-foreground text-sm"
                >
                  via your agent{' '}
                  <span className="font-semibold text-foreground">
                    {notification.agentName}
                  </span>
                </motion.p>
              )}
            </div>

            {/* Content body */}
            <div className="px-6 pt-2 pb-6">
              {/* Market name */}
              <p className="mb-4 font-medium text-foreground text-sm leading-snug">
                {notification.marketName}
              </p>

              {/* Animated points counter */}
              <AnimatedPoints value={notification.points} isWin={isWin} />

              {/* CTA */}
              <div className="flex items-center justify-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground">
                <span>View market</span>
                <ChevronRight className="h-4 w-4" />
              </div>
            </div>

            {/* Auto-dismiss progress bar */}
            <div
              className={cn(
                'h-0.5 origin-left rounded-bl-2xl transition-transform',
                isWin ? 'bg-green-500' : 'bg-red-500'
              )}
              style={{
                transform: 'scaleX(1)',
                animation: `shrink-bar ${AUTO_DISMISS_MS}ms linear forwards`,
                animationPlayState: paused ? 'paused' : 'running',
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
