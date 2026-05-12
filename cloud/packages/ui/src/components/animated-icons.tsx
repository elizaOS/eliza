/**
 * Animated Icons for App Builder
 *
 * Premium animated SVG icons for status indicators.
 * Features smooth CSS animations for a polished AAA feel.
 */

"use client";

import { cn } from "../lib/utils";

interface AnimatedIconProps {
  className?: string;
  size?: number;
  delay?: number;
}

/**
 * Animated checkmark with drawing effect
 * Circle draws first, then checkmark pops in
 */
export function AnimatedCheckmark({ className, size = 16, delay = 0 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-checkmark", className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      <style>
        {`
          .animated-checkmark .circle {
            stroke-dasharray: 76;
            stroke-dashoffset: 76;
            animation: checkCircleDraw 400ms cubic-bezier(0.65, 0, 0.35, 1) forwards;
            animation-delay: inherit;
          }
          .animated-checkmark .check {
            stroke-dasharray: 24;
            stroke-dashoffset: 24;
            animation: checkDraw 300ms cubic-bezier(0.65, 0, 0.35, 1) forwards;
            animation-delay: calc(var(--delay, 0ms) + 250ms);
          }
          @keyframes checkCircleDraw {
            to {
              stroke-dashoffset: 0;
            }
          }
          @keyframes checkDraw {
            to {
              stroke-dashoffset: 0;
            }
          }
        `}
      </style>
      <circle
        className="circle"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        style={{ ["--delay" as string]: `${delay}ms` }}
      />
      <path
        className="check"
        d="M8 12.5L10.5 15L16 9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ animationDelay: `${delay + 250}ms` }}
      />
    </svg>
  );
}

/**
 * Simple checkmark without circle - draws in smoothly
 */
export function AnimatedCheck({ className, size = 14, delay = 0 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("animated-check", className)}
    >
      <style>
        {`
          .animated-check path {
            stroke-dasharray: 20;
            stroke-dashoffset: 20;
            animation: simpleCheckDraw 350ms cubic-bezier(0.65, 0, 0.35, 1) forwards;
          }
          @keyframes simpleCheckDraw {
            to {
              stroke-dashoffset: 0;
            }
          }
        `}
      </style>
      <path
        d="M3 8.5L6.5 12L13 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ animationDelay: `${delay}ms` }}
      />
    </svg>
  );
}

/**
 * Animated loading ring with rotating gradient
 */
export function AnimatedLoadingRing({ className, size = 16 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-loading-ring", className)}
    >
      <style>
        {`
          .animated-loading-ring {
            animation: loadingRingSpin 1s linear infinite;
          }
          .animated-loading-ring .track {
            opacity: 0.2;
          }
          .animated-loading-ring .spinner {
            stroke-dasharray: 60;
            stroke-dashoffset: 45;
            animation: loadingRingDash 1.5s ease-in-out infinite;
          }
          @keyframes loadingRingSpin {
            to {
              transform: rotate(360deg);
            }
          }
          @keyframes loadingRingDash {
            0% {
              stroke-dashoffset: 45;
            }
            50% {
              stroke-dashoffset: 15;
            }
            100% {
              stroke-dashoffset: 45;
            }
          }
        `}
      </style>
      <circle
        className="track"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
      <circle
        className="spinner"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * Animated hourglass/timer with sand flowing
 */
export function AnimatedHourglass({ className, size = 16 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-hourglass", className)}
    >
      <style>
        {`
          .animated-hourglass {
            animation: hourglassRotate 2s ease-in-out infinite;
          }
          .animated-hourglass .sand-top {
            animation: sandDrain 2s ease-in-out infinite;
            transform-origin: center;
          }
          .animated-hourglass .sand-bottom {
            animation: sandFill 2s ease-in-out infinite;
            transform-origin: center bottom;
          }
          @keyframes hourglassRotate {
            0%, 45% {
              transform: rotate(0deg);
            }
            50%, 95% {
              transform: rotate(180deg);
            }
            100% {
              transform: rotate(360deg);
            }
          }
          @keyframes sandDrain {
            0% {
              opacity: 1;
              transform: scaleY(1);
            }
            45% {
              opacity: 0.3;
              transform: scaleY(0.2);
            }
            50% {
              opacity: 1;
              transform: scaleY(1);
            }
            95% {
              opacity: 0.3;
              transform: scaleY(0.2);
            }
            100% {
              opacity: 1;
              transform: scaleY(1);
            }
          }
          @keyframes sandFill {
            0% {
              opacity: 0.3;
              transform: scaleY(0.2);
            }
            45% {
              opacity: 1;
              transform: scaleY(1);
            }
            50% {
              opacity: 0.3;
              transform: scaleY(0.2);
            }
            95% {
              opacity: 1;
              transform: scaleY(1);
            }
            100% {
              opacity: 0.3;
              transform: scaleY(0.2);
            }
          }
        `}
      </style>
      {/* Hourglass frame */}
      <path
        d="M5 3h14v2c0 3.5-3 6-5 7 2 1 5 3.5 5 7v2H5v-2c0-3.5 3-6 5-7-2-1-5-3.5-5-7V3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Sand top */}
      <path
        className="sand-top"
        d="M8 6h8v1c0 1.5-1.5 3-4 4-2.5-1-4-2.5-4-4V6z"
        fill="currentColor"
        opacity="0.6"
      />
      {/* Sand bottom */}
      <path
        className="sand-bottom"
        d="M8 18h8v-1c0-1.5-1.5-3-4-4-2.5 1-4 2.5-4 4v1z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

/**
 * Pulsing dots loading indicator
 */
export function AnimatedDots({ className, size = 16 }: AnimatedIconProps) {
  const dotSize = size / 5;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-dots", className)}
    >
      <style>
        {`
          .animated-dots circle {
            animation: dotPulse 1.4s ease-in-out infinite;
          }
          .animated-dots circle:nth-child(1) {
            animation-delay: 0ms;
          }
          .animated-dots circle:nth-child(2) {
            animation-delay: 200ms;
          }
          .animated-dots circle:nth-child(3) {
            animation-delay: 400ms;
          }
          @keyframes dotPulse {
            0%, 80%, 100% {
              transform: scale(0.6);
              opacity: 0.4;
            }
            40% {
              transform: scale(1);
              opacity: 1;
            }
          }
        `}
      </style>
      <circle cx="6" cy="12" r={dotSize} fill="currentColor" />
      <circle cx="12" cy="12" r={dotSize} fill="currentColor" />
      <circle cx="18" cy="12" r={dotSize} fill="currentColor" />
    </svg>
  );
}

/**
 * Spinning gear/cog for processing state
 */
export function AnimatedGear({ className, size = 16 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-gear", className)}
    >
      <style>
        {`
          .animated-gear {
            animation: gearSpin 3s linear infinite;
          }
          @keyframes gearSpin {
            to {
              transform: rotate(360deg);
            }
          }
        `}
      </style>
      <path
        d="M12 15a3 3 0 100-6 3 3 0 000 6z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * Circular progress with animated stroke
 */
export function AnimatedProgress({
  className,
  size = 16,
  progress = 0, // 0-100
}: AnimatedIconProps & { progress?: number }) {
  const circumference = 2 * Math.PI * 10;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-progress", className)}
      style={{ transform: "rotate(-90deg)" }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.2"
      />
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        style={{
          transition: "stroke-dashoffset 300ms ease-out",
        }}
      />
    </svg>
  );
}

/**
 * Orbiting dots spinner - premium look
 */
export function AnimatedOrbit({ className, size = 16 }: AnimatedIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animated-orbit", className)}
    >
      <style>
        {`
          .animated-orbit .orbit {
            animation: orbitSpin 1.2s linear infinite;
            transform-origin: center;
          }
          .animated-orbit .dot1 {
            animation: orbitDot 1.2s ease-in-out infinite;
          }
          .animated-orbit .dot2 {
            animation: orbitDot 1.2s ease-in-out infinite;
            animation-delay: 0.4s;
          }
          .animated-orbit .dot3 {
            animation: orbitDot 1.2s ease-in-out infinite;
            animation-delay: 0.8s;
          }
          @keyframes orbitSpin {
            to {
              transform: rotate(360deg);
            }
          }
          @keyframes orbitDot {
            0%, 100% {
              opacity: 0.3;
              transform: scale(0.8);
            }
            50% {
              opacity: 1;
              transform: scale(1.2);
            }
          }
        `}
      </style>
      <g className="orbit">
        <circle className="dot1" cx="12" cy="4" r="2" fill="currentColor" />
        <circle className="dot2" cx="18.93" cy="16" r="2" fill="currentColor" />
        <circle className="dot3" cx="5.07" cy="16" r="2" fill="currentColor" />
      </g>
    </svg>
  );
}
