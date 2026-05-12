/**
 * Pet Sprite Component
 *
 * Cute SVG art for the Elizagotchi pet at all life stages and moods.
 * Uses pixel-art style graphics with smooth animations.
 */

import type React from "react";
import type { AnimationType, LifeStage, Mood } from "../game/types";

interface PetSpriteProps {
  stage: LifeStage;
  mood: Mood;
  animation?: AnimationType;
  isSleeping?: boolean;
  className?: string;
}

// ============================================================================
// EGG SPRITE
// ============================================================================

const EggSprite: React.FC<{ animation?: AnimationType }> = ({ animation }) => {
  const wobbleClass = animation === "hatching" ? "hatching" : "egg-wobble";

  return (
    <g className={wobbleClass}>
      {/* Egg shadow */}
      <ellipse cx="50" cy="92" rx="22" ry="6" fill="rgba(0,0,0,0.15)" />

      {/* Egg body */}
      <ellipse cx="50" cy="55" rx="28" ry="38" fill="#FFF8DC" />
      <ellipse cx="50" cy="55" rx="28" ry="38" fill="url(#eggGradient)" />

      {/* Egg spots/pattern */}
      <circle cx="38" cy="45" r="5" fill="#FFE4B5" />
      <circle cx="62" cy="55" r="4" fill="#FFE4B5" />
      <circle cx="45" cy="70" r="3" fill="#FFE4B5" />

      {/* Egg shine */}
      <ellipse cx="40" cy="40" rx="6" ry="10" fill="rgba(255,255,255,0.5)" />

      {/* Crack lines (when hatching) */}
      {animation === "hatching" && (
        <>
          <path
            d="M35 50 L40 55 L35 60 L42 65"
            stroke="#8B4513"
            strokeWidth="2"
            fill="none"
            className="crack"
          />
          <path
            d="M60 45 L55 52 L62 58"
            stroke="#8B4513"
            strokeWidth="2"
            fill="none"
            className="crack"
          />
        </>
      )}
    </g>
  );
};

// ============================================================================
// BABY SPRITE
// ============================================================================

const BabySprite: React.FC<{ mood: Mood; animation?: AnimationType }> = ({
  mood,
  animation,
}) => {
  const bounce =
    animation === "happy" || animation === "playing" ? "bouncing" : "";
  const eyeType =
    mood === "sleeping" ? "closed" : mood === "happy" ? "happy" : "normal";

  return (
    <g className={bounce}>
      {/* Shadow */}
      <ellipse cx="50" cy="92" rx="18" ry="5" fill="rgba(0,0,0,0.15)" />

      {/* Body - small blob */}
      <ellipse cx="50" cy="65" rx="22" ry="25" fill="url(#petGradient)" />

      {/* Cheeks */}
      <circle cx="35" cy="70" r="5" fill="#FFB6C1" opacity="0.6" />
      <circle cx="65" cy="70" r="5" fill="#FFB6C1" opacity="0.6" />

      {/* Eyes */}
      {eyeType === "closed" ? (
        <>
          <path
            d="M40 60 Q45 64 50 60"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M50 60 Q55 64 60 60"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
        </>
      ) : eyeType === "happy" ? (
        <>
          <path
            d="M38 62 Q42 58 46 62"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
          <path
            d="M54 62 Q58 58 62 62"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
        </>
      ) : (
        <>
          <circle cx="42" cy="60" r="4" fill="#333" />
          <circle cx="58" cy="60" r="4" fill="#333" />
          <circle cx="43" cy="59" r="1.5" fill="#FFF" />
          <circle cx="59" cy="59" r="1.5" fill="#FFF" />
        </>
      )}

      {/* Mouth */}
      {mood === "happy" ? (
        <path
          d="M45 72 Q50 78 55 72"
          stroke="#333"
          strokeWidth="2"
          fill="none"
        />
      ) : mood === "sad" ? (
        <path
          d="M45 76 Q50 72 55 76"
          stroke="#333"
          strokeWidth="2"
          fill="none"
        />
      ) : (
        <ellipse cx="50" cy="74" rx="3" ry="2" fill="#333" />
      )}

      {/* Little feet */}
      <ellipse cx="40" cy="88" rx="8" ry="4" fill="url(#petGradient)" />
      <ellipse cx="60" cy="88" rx="8" ry="4" fill="url(#petGradient)" />
    </g>
  );
};

// ============================================================================
// CHILD SPRITE
// ============================================================================

const ChildSprite: React.FC<{ mood: Mood; animation?: AnimationType }> = ({
  mood,
  animation,
}) => {
  const bounce =
    animation === "happy" || animation === "playing" ? "bouncing" : "";
  const eyeType =
    mood === "sleeping" ? "closed" : mood === "happy" ? "happy" : "normal";

  return (
    <g className={bounce}>
      {/* Shadow */}
      <ellipse cx="50" cy="92" rx="20" ry="5" fill="rgba(0,0,0,0.15)" />

      {/* Body */}
      <ellipse cx="50" cy="62" rx="25" ry="28" fill="url(#petGradient)" />

      {/* Ears */}
      <ellipse
        cx="30"
        cy="38"
        rx="8"
        ry="12"
        fill="url(#petGradient)"
        transform="rotate(-15 30 38)"
      />
      <ellipse
        cx="70"
        cy="38"
        rx="8"
        ry="12"
        fill="url(#petGradient)"
        transform="rotate(15 70 38)"
      />
      <ellipse
        cx="30"
        cy="38"
        rx="4"
        ry="7"
        fill="#FFB6C1"
        transform="rotate(-15 30 38)"
      />
      <ellipse
        cx="70"
        cy="38"
        rx="4"
        ry="7"
        fill="#FFB6C1"
        transform="rotate(15 70 38)"
      />

      {/* Cheeks */}
      <circle cx="32" cy="65" r="6" fill="#FFB6C1" opacity="0.5" />
      <circle cx="68" cy="65" r="6" fill="#FFB6C1" opacity="0.5" />

      {/* Eyes */}
      {eyeType === "closed" ? (
        <>
          <path
            d="M38 55 Q44 60 50 55"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M50 55 Q56 60 62 55"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
        </>
      ) : eyeType === "happy" ? (
        <>
          <path
            d="M36 58 Q42 52 48 58"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
          <path
            d="M52 58 Q58 52 64 58"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
        </>
      ) : (
        <>
          <circle cx="42" cy="55" r="5" fill="#333" />
          <circle cx="58" cy="55" r="5" fill="#333" />
          <circle cx="43.5" cy="53.5" r="2" fill="#FFF" />
          <circle cx="59.5" cy="53.5" r="2" fill="#FFF" />
        </>
      )}

      {/* Nose */}
      <ellipse cx="50" cy="65" rx="3" ry="2" fill="#8B4513" />

      {/* Mouth */}
      {mood === "happy" ? (
        <path
          d="M43 72 Q50 80 57 72"
          stroke="#333"
          strokeWidth="2"
          fill="none"
        />
      ) : mood === "sad" ? (
        <path
          d="M43 78 Q50 72 57 78"
          stroke="#333"
          strokeWidth="2"
          fill="none"
        />
      ) : mood === "hungry" ? (
        <circle cx="50" cy="75" r="4" fill="#333" />
      ) : (
        <path d="M45 74 L55 74" stroke="#333" strokeWidth="2" />
      )}

      {/* Arms */}
      <ellipse cx="28" cy="70" rx="6" ry="10" fill="url(#petGradient)" />
      <ellipse cx="72" cy="70" rx="6" ry="10" fill="url(#petGradient)" />

      {/* Feet */}
      <ellipse cx="38" cy="88" rx="10" ry="5" fill="url(#petGradient)" />
      <ellipse cx="62" cy="88" rx="10" ry="5" fill="url(#petGradient)" />
    </g>
  );
};

// ============================================================================
// TEEN SPRITE
// ============================================================================

const TeenSprite: React.FC<{ mood: Mood; animation?: AnimationType }> = ({
  mood,
  animation,
}) => {
  const bounce =
    animation === "happy" || animation === "playing" ? "bouncing" : "";
  const eyeType =
    mood === "sleeping"
      ? "closed"
      : mood === "happy"
        ? "happy"
        : mood === "angry"
          ? "angry"
          : "normal";

  return (
    <g className={bounce}>
      {/* Shadow */}
      <ellipse cx="50" cy="94" rx="22" ry="5" fill="rgba(0,0,0,0.15)" />

      {/* Body */}
      <ellipse cx="50" cy="58" rx="28" ry="32" fill="url(#petGradient)" />

      {/* Spiky hair/crest */}
      <polygon points="35,28 40,15 45,28" fill="url(#petGradient)" />
      <polygon points="45,25 50,10 55,25" fill="url(#petGradient)" />
      <polygon points="55,28 60,15 65,28" fill="url(#petGradient)" />

      {/* Ears */}
      <ellipse
        cx="25"
        cy="40"
        rx="10"
        ry="14"
        fill="url(#petGradient)"
        transform="rotate(-20 25 40)"
      />
      <ellipse
        cx="75"
        cy="40"
        rx="10"
        ry="14"
        fill="url(#petGradient)"
        transform="rotate(20 75 40)"
      />
      <ellipse
        cx="25"
        cy="40"
        rx="5"
        ry="8"
        fill="#FFB6C1"
        transform="rotate(-20 25 40)"
      />
      <ellipse
        cx="75"
        cy="40"
        rx="5"
        ry="8"
        fill="#FFB6C1"
        transform="rotate(20 75 40)"
      />

      {/* Cheeks */}
      <circle cx="30" cy="60" r="7" fill="#FFB6C1" opacity="0.4" />
      <circle cx="70" cy="60" r="7" fill="#FFB6C1" opacity="0.4" />

      {/* Eyes */}
      {eyeType === "closed" ? (
        <>
          <path
            d="M35 50 Q42 56 49 50"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
          <path
            d="M51 50 Q58 56 65 50"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
        </>
      ) : eyeType === "happy" ? (
        <>
          <path
            d="M34 52 Q42 45 50 52"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
          <path
            d="M50 52 Q58 45 66 52"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
        </>
      ) : eyeType === "angry" ? (
        <>
          <line x1="34" y1="44" x2="46" y2="48" stroke="#333" strokeWidth="2" />
          <line x1="66" y1="44" x2="54" y2="48" stroke="#333" strokeWidth="2" />
          <circle cx="40" cy="52" r="5" fill="#333" />
          <circle cx="60" cy="52" r="5" fill="#333" />
        </>
      ) : (
        <>
          <circle cx="40" cy="50" r="6" fill="#333" />
          <circle cx="60" cy="50" r="6" fill="#333" />
          <circle cx="42" cy="48" r="2.5" fill="#FFF" />
          <circle cx="62" cy="48" r="2.5" fill="#FFF" />
        </>
      )}

      {/* Nose */}
      <ellipse cx="50" cy="62" rx="4" ry="3" fill="#8B4513" />

      {/* Mouth */}
      {mood === "happy" ? (
        <path
          d="M40 70 Q50 82 60 70"
          stroke="#333"
          strokeWidth="2.5"
          fill="none"
        />
      ) : mood === "sad" ? (
        <path
          d="M40 78 Q50 70 60 78"
          stroke="#333"
          strokeWidth="2.5"
          fill="none"
        />
      ) : mood === "angry" ? (
        <path d="M42 76 L58 76" stroke="#333" strokeWidth="3" />
      ) : (
        <ellipse cx="50" cy="73" rx="4" ry="3" fill="#333" />
      )}

      {/* Arms */}
      <ellipse cx="25" cy="68" rx="8" ry="12" fill="url(#petGradient)" />
      <ellipse cx="75" cy="68" rx="8" ry="12" fill="url(#petGradient)" />

      {/* Feet */}
      <ellipse cx="36" cy="90" rx="12" ry="6" fill="url(#petGradient)" />
      <ellipse cx="64" cy="90" rx="12" ry="6" fill="url(#petGradient)" />
    </g>
  );
};

// ============================================================================
// ADULT SPRITE
// ============================================================================

const AdultSprite: React.FC<{ mood: Mood; animation?: AnimationType }> = ({
  mood,
  animation,
}) => {
  const bounce =
    animation === "happy" ||
    animation === "playing" ||
    animation === "celebrating"
      ? "bouncing"
      : "";
  const eyeType =
    mood === "sleeping" ? "closed" : mood === "happy" ? "happy" : "normal";

  return (
    <g className={bounce}>
      {/* Shadow */}
      <ellipse cx="50" cy="94" rx="24" ry="6" fill="rgba(0,0,0,0.15)" />

      {/* Body */}
      <ellipse cx="50" cy="55" rx="30" ry="35" fill="url(#petGradient)" />

      {/* Crown/crest */}
      <ellipse cx="50" cy="22" rx="15" ry="8" fill="url(#petGradient)" />
      <circle cx="42" cy="18" r="5" fill="#FFD700" />
      <circle cx="50" cy="15" r="6" fill="#FFD700" />
      <circle cx="58" cy="18" r="5" fill="#FFD700" />

      {/* Ears */}
      <ellipse
        cx="22"
        cy="38"
        rx="12"
        ry="16"
        fill="url(#petGradient)"
        transform="rotate(-25 22 38)"
      />
      <ellipse
        cx="78"
        cy="38"
        rx="12"
        ry="16"
        fill="url(#petGradient)"
        transform="rotate(25 78 38)"
      />
      <ellipse
        cx="22"
        cy="38"
        rx="6"
        ry="10"
        fill="#FFB6C1"
        transform="rotate(-25 22 38)"
      />
      <ellipse
        cx="78"
        cy="38"
        rx="6"
        ry="10"
        fill="#FFB6C1"
        transform="rotate(25 78 38)"
      />

      {/* Cheeks */}
      <circle cx="28" cy="58" r="8" fill="#FFB6C1" opacity="0.4" />
      <circle cx="72" cy="58" r="8" fill="#FFB6C1" opacity="0.4" />

      {/* Eyes */}
      {eyeType === "closed" ? (
        <>
          <path
            d="M32 48 Q40 55 48 48"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
          <path
            d="M52 48 Q60 55 68 48"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
        </>
      ) : eyeType === "happy" ? (
        <>
          <path
            d="M32 50 Q40 42 48 50"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
          <path
            d="M52 50 Q60 42 68 50"
            stroke="#333"
            strokeWidth="3"
            fill="none"
          />
        </>
      ) : (
        <>
          <ellipse cx="40" cy="48" rx="7" ry="8" fill="#FFF" />
          <ellipse cx="60" cy="48" rx="7" ry="8" fill="#FFF" />
          <circle cx="40" cy="48" r="5" fill="#333" />
          <circle cx="60" cy="48" r="5" fill="#333" />
          <circle cx="42" cy="46" r="2" fill="#FFF" />
          <circle cx="62" cy="46" r="2" fill="#FFF" />
        </>
      )}

      {/* Nose */}
      <ellipse cx="50" cy="60" rx="5" ry="4" fill="#8B4513" />
      <ellipse cx="50" cy="59" rx="2" ry="1.5" fill="#D2691E" />

      {/* Mouth */}
      {mood === "happy" ? (
        <>
          <path
            d="M38 68 Q50 82 62 68"
            stroke="#333"
            strokeWidth="2.5"
            fill="none"
          />
          <path d="M42 70 Q50 78 58 70" fill="#FF6B6B" />
        </>
      ) : mood === "sad" ? (
        <path
          d="M38 78 Q50 68 62 78"
          stroke="#333"
          strokeWidth="2.5"
          fill="none"
        />
      ) : (
        <path
          d="M42 72 Q50 76 58 72"
          stroke="#333"
          strokeWidth="2"
          fill="none"
        />
      )}

      {/* Arms */}
      <ellipse cx="22" cy="65" rx="10" ry="14" fill="url(#petGradient)" />
      <ellipse cx="78" cy="65" rx="10" ry="14" fill="url(#petGradient)" />

      {/* Belly pattern */}
      <ellipse cx="50" cy="70" rx="15" ry="12" fill="#FFF8DC" opacity="0.5" />

      {/* Feet */}
      <ellipse cx="34" cy="90" rx="14" ry="7" fill="url(#petGradient)" />
      <ellipse cx="66" cy="90" rx="14" ry="7" fill="url(#petGradient)" />
    </g>
  );
};

// ============================================================================
// ELDER SPRITE
// ============================================================================

const ElderSprite: React.FC<{ mood: Mood; animation?: AnimationType }> = ({
  mood,
  animation,
}) => {
  const eyeType = mood === "sleeping" ? "closed" : "normal";

  return (
    <g className={animation === "happy" ? "gentle-bounce" : ""}>
      {/* Shadow */}
      <ellipse cx="50" cy="94" rx="24" ry="6" fill="rgba(0,0,0,0.15)" />

      {/* Body - slightly droopy */}
      <ellipse cx="50" cy="58" rx="28" ry="32" fill="url(#elderGradient)" />

      {/* Gray hair/fluff */}
      <ellipse cx="50" cy="28" rx="20" ry="12" fill="#D3D3D3" />
      <circle cx="35" cy="30" r="8" fill="#D3D3D3" />
      <circle cx="65" cy="30" r="8" fill="#D3D3D3" />

      {/* Droopy ears */}
      <ellipse
        cx="22"
        cy="50"
        rx="10"
        ry="18"
        fill="url(#elderGradient)"
        transform="rotate(-10 22 50)"
      />
      <ellipse
        cx="78"
        cy="50"
        rx="10"
        ry="18"
        fill="url(#elderGradient)"
        transform="rotate(10 78 50)"
      />

      {/* Cheeks */}
      <circle cx="30" cy="60" r="7" fill="#FFB6C1" opacity="0.3" />
      <circle cx="70" cy="60" r="7" fill="#FFB6C1" opacity="0.3" />

      {/* Eyes - slightly squinty */}
      {eyeType === "closed" ? (
        <>
          <path
            d="M34 52 Q40 56 46 52"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M54 52 Q60 56 66 52"
            stroke="#333"
            strokeWidth="2"
            fill="none"
          />
        </>
      ) : (
        <>
          <ellipse cx="40" cy="50" rx="5" ry="4" fill="#333" />
          <ellipse cx="60" cy="50" rx="5" ry="4" fill="#333" />
          <circle cx="41" cy="49" r="1.5" fill="#FFF" />
          <circle cx="61" cy="49" r="1.5" fill="#FFF" />
        </>
      )}

      {/* Eyebrows - wise looking */}
      <path d="M32 44 Q38 42 46 44" stroke="#888" strokeWidth="2" fill="none" />
      <path d="M54 44 Q62 42 68 44" stroke="#888" strokeWidth="2" fill="none" />

      {/* Nose */}
      <ellipse cx="50" cy="60" rx="4" ry="3" fill="#8B4513" />

      {/* Gentle smile */}
      <path d="M42 70 Q50 76 58 70" stroke="#333" strokeWidth="2" fill="none" />

      {/* Walking stick (optional decoration) */}
      <line x1="80" y1="45" x2="85" y2="92" stroke="#8B4513" strokeWidth="3" />
      <ellipse cx="85" cy="44" rx="4" ry="3" fill="#8B4513" />

      {/* Feet */}
      <ellipse cx="36" cy="88" rx="12" ry="6" fill="url(#elderGradient)" />
      <ellipse cx="64" cy="88" rx="12" ry="6" fill="url(#elderGradient)" />
    </g>
  );
};

// ============================================================================
// DEAD SPRITE (Angel)
// ============================================================================

const DeadSprite: React.FC = () => {
  return (
    <g className="floating">
      {/* Halo */}
      <ellipse
        cx="50"
        cy="15"
        rx="18"
        ry="5"
        fill="none"
        stroke="#FFD700"
        strokeWidth="3"
      />
      <ellipse
        cx="50"
        cy="15"
        rx="18"
        ry="5"
        fill="none"
        stroke="#FFF"
        strokeWidth="1"
        opacity="0.5"
      />

      {/* Ghost body */}
      <path
        d="M30 45 Q30 25 50 25 Q70 25 70 45 L70 75 Q65 70 60 75 Q55 80 50 75 Q45 80 40 75 Q35 70 30 75 Z"
        fill="rgba(255,255,255,0.8)"
      />

      {/* Closed peaceful eyes */}
      <path d="M38 45 Q42 48 46 45" stroke="#666" strokeWidth="2" fill="none" />
      <path d="M54 45 Q58 48 62 45" stroke="#666" strokeWidth="2" fill="none" />

      {/* Peaceful smile */}
      <path d="M44 55 Q50 60 56 55" stroke="#666" strokeWidth="2" fill="none" />

      {/* Wings */}
      <ellipse
        cx="20"
        cy="50"
        rx="15"
        ry="20"
        fill="rgba(255,255,255,0.6)"
        transform="rotate(-20 20 50)"
      />
      <ellipse
        cx="80"
        cy="50"
        rx="15"
        ry="20"
        fill="rgba(255,255,255,0.6)"
        transform="rotate(20 80 50)"
      />

      {/* Sparkles */}
      <circle cx="25" cy="35" r="2" fill="#FFD700" className="sparkle" />
      <circle
        cx="75"
        cy="40"
        r="2"
        fill="#FFD700"
        className="sparkle delay-1"
      />
      <circle
        cx="40"
        cy="80"
        r="1.5"
        fill="#FFD700"
        className="sparkle delay-2"
      />
      <circle
        cx="65"
        cy="85"
        r="1.5"
        fill="#FFD700"
        className="sparkle delay-3"
      />
    </g>
  );
};

// ============================================================================
// SICK OVERLAY
// ============================================================================

const SickOverlay: React.FC = () => (
  <g className="sick-pulse">
    {/* Sweat drops */}
    <path d="M25 35 Q27 40 25 45 Q23 40 25 35" fill="#87CEEB" />
    <path
      d="M75 38 Q77 43 75 48 Q73 43 75 38"
      fill="#87CEEB"
      className="delay-1"
    />

    {/* Thermometer */}
    <g transform="translate(72, 55) rotate(30)">
      <rect x="-2" y="-15" width="4" height="20" rx="2" fill="#FFF" />
      <circle cx="0" cy="8" r="5" fill="#FF4444" />
      <rect x="-1" y="-10" width="2" height="15" fill="#FF4444" />
    </g>
  </g>
);

// ============================================================================
// SLEEPING OVERLAY
// ============================================================================

const SleepingOverlay: React.FC = () => (
  <g>
    <text x="65" y="30" fontSize="16" fill="#6495ED" className="zzz zzz-1">
      Z
    </text>
    <text x="72" y="22" fontSize="14" fill="#6495ED" className="zzz zzz-2">
      z
    </text>
    <text x="78" y="16" fontSize="12" fill="#6495ED" className="zzz zzz-3">
      z
    </text>
  </g>
);

// ============================================================================
// MAIN PET SPRITE COMPONENT
// ============================================================================

export const PetSprite: React.FC<PetSpriteProps> = ({
  stage,
  mood,
  animation = "idle",
  isSleeping = false,
  className = "",
}) => {
  const renderPet = () => {
    switch (stage) {
      case "egg":
        return <EggSprite animation={animation} />;
      case "baby":
        return <BabySprite mood={mood} animation={animation} />;
      case "child":
        return <ChildSprite mood={mood} animation={animation} />;
      case "teen":
        return <TeenSprite mood={mood} animation={animation} />;
      case "adult":
        return <AdultSprite mood={mood} animation={animation} />;
      case "elder":
        return <ElderSprite mood={mood} animation={animation} />;
      case "dead":
        return <DeadSprite />;
      default:
        return <EggSprite animation={animation} />;
    }
  };

  return (
    <svg
      viewBox="0 0 100 100"
      className={`pet-sprite ${className}`}
      style={{
        width: "100%",
        height: "100%",
        maxWidth: "200px",
        maxHeight: "200px",
      }}
    >
      <defs>
        {/* Main pet gradient - warm peachy/pink */}
        <radialGradient id="petGradient" cx="40%" cy="30%" r="60%">
          <stop offset="0%" stopColor="#FFDAB9" />
          <stop offset="50%" stopColor="#FFB6C1" />
          <stop offset="100%" stopColor="#DDA0DD" />
        </radialGradient>

        {/* Elder pet gradient - grayer tones */}
        <radialGradient id="elderGradient" cx="40%" cy="30%" r="60%">
          <stop offset="0%" stopColor="#E8E8E8" />
          <stop offset="50%" stopColor="#D8BFD8" />
          <stop offset="100%" stopColor="#C0C0C0" />
        </radialGradient>

        {/* Egg gradient */}
        <radialGradient id="eggGradient" cx="30%" cy="30%" r="70%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.3)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
      </defs>

      {renderPet()}

      {/* Overlays */}
      {mood === "sick" && stage !== "dead" && <SickOverlay />}
      {isSleeping && stage !== "dead" && <SleepingOverlay />}
    </svg>
  );
};

export default PetSprite;
