/**
 * Game Elements - Additional SVG components for the Elizagotchi game
 * Includes the background and poop sprites used by the game scene.
 */

import type React from "react";

// ============================================================================
// POOP SPRITE
// ============================================================================

interface PoopProps {
  x: number;
  y: number;
  size?: number;
}

export const Poop: React.FC<PoopProps> = ({ x, y, size = 20 }) => (
  <svg
    x={x}
    y={y}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className="poop-drop"
  >
    <path
      d="M12 2C9 2 7 4 7 6C5 6 3 8 3 11C3 14 5 16 8 16C8 18 10 22 12 22C14 22 16 18 16 16C19 16 21 14 21 11C21 8 19 6 17 6C17 4 15 2 12 2Z"
      fill="#8B4513"
    />
    <ellipse cx="9" cy="10" rx="2" ry="1.5" fill="#A0522D" />
    <ellipse cx="15" cy="10" rx="2" ry="1.5" fill="#A0522D" />
    {/* Stink lines */}
    <path
      d="M6 4 Q4 2 6 0"
      stroke="#90EE90"
      strokeWidth="1"
      fill="none"
      opacity="0.7"
    />
    <path
      d="M12 3 Q10 1 12 -1"
      stroke="#90EE90"
      strokeWidth="1"
      fill="none"
      opacity="0.7"
    />
    <path
      d="M18 4 Q16 2 18 0"
      stroke="#90EE90"
      strokeWidth="1"
      fill="none"
      opacity="0.7"
    />
  </svg>
);

export const Clouds: React.FC = () => (
  <g className="clouds">
    <ellipse
      cx="20"
      cy="15"
      rx="15"
      ry="8"
      fill="rgba(255,255,255,0.8)"
      className="cloud cloud-1"
    />
    <ellipse
      cx="30"
      cy="12"
      rx="10"
      ry="6"
      fill="rgba(255,255,255,0.8)"
      className="cloud cloud-1"
    />

    <ellipse
      cx="80"
      cy="20"
      rx="12"
      ry="7"
      fill="rgba(255,255,255,0.7)"
      className="cloud cloud-2"
    />
    <ellipse
      cx="90"
      cy="18"
      rx="8"
      ry="5"
      fill="rgba(255,255,255,0.7)"
      className="cloud cloud-2"
    />
  </g>
);

export const Stars: React.FC = () => (
  <g className="stars">
    {[
      { x: 15, y: 10, size: 3, delay: 0 },
      { x: 40, y: 25, size: 2, delay: 500 },
      { x: 70, y: 15, size: 4, delay: 1000 },
      { x: 85, y: 30, size: 2.5, delay: 1500 },
      { x: 25, y: 35, size: 2, delay: 2000 },
      { x: 55, y: 8, size: 3, delay: 2500 },
    ].map((star, i) => (
      <g key={i} className="star" style={{ animationDelay: `${star.delay}ms` }}>
        <circle cx={star.x} cy={star.y} r={star.size} fill="#FFD700" />
        <line
          x1={star.x - star.size * 1.5}
          y1={star.y}
          x2={star.x + star.size * 1.5}
          y2={star.y}
          stroke="#FFD700"
          strokeWidth="1"
        />
        <line
          x1={star.x}
          y1={star.y - star.size * 1.5}
          x2={star.x}
          y2={star.y + star.size * 1.5}
          stroke="#FFD700"
          strokeWidth="1"
        />
      </g>
    ))}
  </g>
);

export const Ground: React.FC<{ isNight?: boolean }> = ({ isNight }) => (
  <g>
    {/* Grass/ground */}
    <rect
      x="0"
      y="85"
      width="100"
      height="15"
      fill={isNight ? "#2D5016" : "#7CFC00"}
    />
    <ellipse
      cx="10"
      cy="85"
      rx="12"
      ry="3"
      fill={isNight ? "#1E4010" : "#32CD32"}
    />
    <ellipse
      cx="35"
      cy="86"
      rx="15"
      ry="4"
      fill={isNight ? "#1E4010" : "#32CD32"}
    />
    <ellipse
      cx="65"
      cy="85"
      rx="18"
      ry="3"
      fill={isNight ? "#1E4010" : "#32CD32"}
    />
    <ellipse
      cx="90"
      cy="86"
      rx="12"
      ry="3"
      fill={isNight ? "#1E4010" : "#32CD32"}
    />

    {/* Flowers (day only) */}
    {!isNight && (
      <>
        <circle cx="15" cy="82" r="3" fill="#FF69B4" />
        <circle cx="15" cy="82" r="1" fill="#FFD700" />
        <circle cx="80" cy="83" r="2.5" fill="#87CEEB" />
        <circle cx="80" cy="83" r="0.8" fill="#FFD700" />
        <circle cx="45" cy="82" r="2" fill="#FFB6C1" />
        <circle cx="45" cy="82" r="0.6" fill="#FFD700" />
      </>
    )}
  </g>
);
