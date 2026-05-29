"use client";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

interface ShootingStar {
  id: number;
  x: number;
  y: number;
  angle: number;
  scale: number;
  speed: number;
  distance: number;
}

interface ShootingStarsProps {
  minSpeed?: number;
  maxSpeed?: number;
  minDelay?: number;
  maxDelay?: number;
  starColor?: string;
  trailColor?: string;
  starWidth?: number;
  starHeight?: number;
  className?: string;
}

const getRandomStartPoint = () => {
  const side = Math.floor(Math.random() * 4);
  const offset = Math.random() * window.innerWidth;

  switch (side) {
    case 0:
      return { x: offset, y: 0, angle: 45 };
    case 1:
      return { x: window.innerWidth, y: offset, angle: 135 };
    case 2:
      return { x: offset, y: window.innerHeight, angle: 225 };
    case 3:
      return { x: 0, y: offset, angle: 315 };
    default:
      return { x: 0, y: 0, angle: 45 };
  }
};
export const ShootingStars: React.FC<ShootingStarsProps> = ({
  minSpeed = 10,
  maxSpeed = 30,
  minDelay = 1200,
  maxDelay = 4200,
  starColor = "#9E00FF",
  trailColor = "#2EB9DF",
  starWidth = 10,
  starHeight = 1,
  className,
}) => {
  const [star, setStar] = useState<ShootingStar | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Mutable position lives in a ref so the animation runs in a single rAF loop
  // instead of re-subscribing a new requestAnimationFrame on every state change.
  const starRef = useRef<ShootingStar | null>(null);

  useEffect(() => {
    let spawnTimer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    let cancelled = false;

    const spawnStar = () => {
      const { x, y, angle } = getRandomStartPoint();
      const newStar: ShootingStar = {
        id: Date.now(),
        x,
        y,
        angle,
        scale: 1,
        speed: Math.random() * (maxSpeed - minSpeed) + minSpeed,
        distance: 0,
      };
      starRef.current = newStar;
      setStar(newStar);

      const randomDelay = Math.random() * (maxDelay - minDelay) + minDelay;
      spawnTimer = setTimeout(spawnStar, randomDelay);
    };

    const tick = () => {
      if (cancelled) return;
      const prev = starRef.current;
      if (prev) {
        const newX =
          prev.x + prev.speed * Math.cos((prev.angle * Math.PI) / 180);
        const newY =
          prev.y + prev.speed * Math.sin((prev.angle * Math.PI) / 180);
        const newDistance = prev.distance + prev.speed;
        if (
          newX < -20 ||
          newX > window.innerWidth + 20 ||
          newY < -20 ||
          newY > window.innerHeight + 20
        ) {
          starRef.current = null;
          setStar(null);
        } else {
          const next: ShootingStar = {
            ...prev,
            x: newX,
            y: newY,
            distance: newDistance,
            scale: 1 + newDistance / 100,
          };
          starRef.current = next;
          setStar(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    spawnStar();
    frame = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (spawnTimer) clearTimeout(spawnTimer);
      cancelAnimationFrame(frame);
    };
  }, [minSpeed, maxSpeed, minDelay, maxDelay]);

  return (
    <svg
      aria-hidden="true"
      ref={svgRef}
      className={cn("w-full h-full absolute inset-0", className)}
    >
      {star && (
        <rect
          key={star.id}
          x={star.x}
          y={star.y}
          width={starWidth * star.scale}
          height={starHeight}
          fill="url(#gradient)"
          transform={`rotate(${star.angle}, ${
            star.x + (starWidth * star.scale) / 2
          }, ${star.y + starHeight / 2})`}
        />
      )}
      <defs>
        <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: trailColor, stopOpacity: 0 }} />
          <stop
            offset="100%"
            style={{ stopColor: starColor, stopOpacity: 1 }}
          />
        </linearGradient>
      </defs>
    </svg>
  );
};
