/**
 * Game Elements - Additional SVG components for the Elizagotchi game
 * Includes: Poop, Food, Hearts, Action Icons, etc.
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

// ============================================================================
// HEART ANIMATION
// ============================================================================

interface HeartProps {
  x: number;
  y: number;
  delay?: number;
}

export const Heart: React.FC<HeartProps> = ({ x, y, delay = 0 }) => (
  <svg
    x={x}
    y={y}
    width="20"
    height="20"
    viewBox="0 0 24 24"
    className="floating-heart"
    style={{ animationDelay: `${delay}ms` }}
  >
    <path
      d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      fill="#FF6B9D"
    />
  </svg>
);

// ============================================================================
// FOOD SPRITE
// ============================================================================

export const FoodSprite: React.FC<{ type?: "meal" | "snack" }> = ({
  type = "meal",
}) => (
  <svg width="40" height="40" viewBox="0 0 40 40" className="food-bounce">
    {type === "meal" ? (
      // Hamburger
      <>
        <ellipse cx="20" cy="30" rx="15" ry="4" fill="#D2691E" />
        <rect x="6" y="18" width="28" height="12" rx="2" fill="#228B22" />
        <rect x="5" y="15" width="30" height="5" rx="2" fill="#FF6347" />
        <ellipse cx="20" cy="12" rx="16" ry="6" fill="#DEB887" />
        <ellipse cx="15" cy="10" rx="2" ry="1" fill="#FFF8DC" />
        <ellipse cx="22" cy="9" rx="1.5" ry="0.8" fill="#FFF8DC" />
        <ellipse cx="26" cy="11" rx="1" ry="0.5" fill="#FFF8DC" />
      </>
    ) : (
      // Cookie
      <>
        <circle cx="20" cy="20" r="15" fill="#D2691E" />
        <circle cx="12" cy="15" r="3" fill="#5D4037" />
        <circle cx="25" cy="12" r="2.5" fill="#5D4037" />
        <circle cx="18" cy="24" r="2.5" fill="#5D4037" />
        <circle cx="27" cy="22" r="2" fill="#5D4037" />
        <circle cx="14" cy="27" r="2" fill="#5D4037" />
      </>
    )}
  </svg>
);

// ============================================================================
// ACTION BUTTON ICONS
// ============================================================================

export const FeedIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C8 2 4 6 4 10c0 2.5 1.5 5 4 6v4c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2v-4c2.5-1 4-3.5 4-6 0-4-4-8-8-8zm0 2c3 0 6 3 6 6 0 1.5-.8 3-2 4l-1 .5V20h-2v-6h-2v6h-2v-5.5L8 14c-1.2-1-2-2.5-2-4 0-3 3-6 6-6z" />
    <circle cx="12" cy="9" r="3" />
  </svg>
);

export const PlayIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <circle
      cx="12"
      cy="12"
      r="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path d="M10 8l6 4-6 4V8z" />
  </svg>
);

export const CleanIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 8h-1V6c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v2H5c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-9c0-1.1-.9-2-2-2zM8 6h8v2H8V6zm11 13H5v-9h14v9z" />
    <path d="M12 11c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
  </svg>
);

export const SleepIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.43 2.3c-2.38-.59-4.68-.27-6.63.64-.35.16-.41.64-.1.86C8.3 5.6 10 8.6 10 12c0 3.4-1.7 6.4-4.3 8.2-.32.22-.26.7.09.86 1.28.6 2.71.94 4.21.94 6.05 0 10.85-5.38 9.87-11.6-.61-3.92-3.59-7.16-7.44-8.1z" />
  </svg>
);

export const MedicineIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14h-2v-4H6v-2h4V7h2v4h4v2h-4v4z" />
  </svg>
);

export const DisciplineIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
  </svg>
);

export const LightIcon: React.FC<{ on?: boolean }> = ({ on = true }) => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    {on ? (
      <>
        <circle cx="12" cy="12" r="5" />
        <path
          d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
        />
      </>
    ) : (
      <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
    )}
  </svg>
);

// ============================================================================
// BACKGROUND ELEMENTS
// ============================================================================

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

// ============================================================================
// ANIMATED SPARKLES (for celebrations)
// ============================================================================

export const Sparkles: React.FC = () => (
  <g className="sparkles-container">
    {[...Array(8)].map((_, i) => {
      const angle = (i * 45 * Math.PI) / 180;
      const x = 50 + Math.cos(angle) * 35;
      const y = 50 + Math.sin(angle) * 35;
      return (
        <g
          key={i}
          className="sparkle-group"
          style={{ animationDelay: `${i * 100}ms` }}
        >
          <polygon
            points={`${x},${y - 5} ${x + 2},${y} ${x},${y + 5} ${x - 2},${y}`}
            fill="#FFD700"
            className="sparkle"
          />
        </g>
      );
    })}
  </g>
);

// ============================================================================
// EVOLUTION ANIMATION
// ============================================================================

export const EvolutionGlow: React.FC = () => (
  <g className="evolution-glow">
    <circle
      cx="50"
      cy="50"
      r="45"
      fill="none"
      stroke="url(#evolutionGradient)"
      strokeWidth="4"
    />
    <defs>
      <radialGradient id="evolutionGradient">
        <stop offset="0%" stopColor="#FFD700" />
        <stop offset="50%" stopColor="#FF69B4" />
        <stop offset="100%" stopColor="#87CEEB" />
      </radialGradient>
    </defs>
  </g>
);
