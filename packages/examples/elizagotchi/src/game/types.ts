/**
 * Elizagotchi - Virtual Pet Game Types
 *
 * A Tamagotchi-style virtual pet with all classic mechanics.
 */

// Life stages of the pet
export type LifeStage =
  | "egg"
  | "baby"
  | "child"
  | "teen"
  | "adult"
  | "elder"
  | "dead";

// Emotional states
export type Mood =
  | "happy"
  | "content"
  | "neutral"
  | "sad"
  | "angry"
  | "sick"
  | "sleeping"
  | "hungry"
  | "dirty"
  | "dead";

// Available actions the player can take
export type Action =
  | "feed"
  | "play"
  | "clean"
  | "sleep"
  | "medicine"
  | "discipline"
  | "light_toggle";

// Pet personality types (determined by care quality)
export type Personality =
  | "angel" // Best care - always happy, healthy
  | "normal" // Average care
  | "rebel" // Neglected - misbehaves
  | "sickly"; // Poor health care

// Pet stats (0-100 scale)
export interface PetStats {
  hunger: number; // 100 = full, 0 = starving
  happiness: number; // 100 = ecstatic, 0 = miserable
  health: number; // 100 = perfect health, 0 = critical
  energy: number; // 100 = fully rested, 0 = exhausted
  cleanliness: number; // 100 = sparkling, 0 = filthy
  discipline: number; // 100 = well-behaved, 0 = wild
}

// Evolution tracking
export interface EvolutionData {
  careScore: number; // Cumulative care quality (0-100)
  missedCare: number; // Times needs were ignored
  sickCount: number; // Times pet got sick
  overfeedings: number; // Times overfed
  playCount: number; // Times played with
  disciplineCount: number; // Times disciplined
}

// Complete pet state
export interface PetState {
  name: string;
  stage: LifeStage;
  mood: Mood;
  stats: PetStats;
  evolution: EvolutionData;
  personality: Personality;

  // Timing
  birthTime: number; // Unix timestamp of birth
  lastUpdate: number; // Last stat decay update
  stageStartTime: number; // When current stage started
  lastFed: number; // Last feeding time
  lastPlayed: number; // Last play time
  lastCleaned: number; // Last cleaning time
  lastSlept: number; // Last sleep time

  // Flags
  isSick: boolean;
  isSleeping: boolean;
  lightsOn: boolean;
  needsAttention: boolean; // Calling for player
  poop: number; // Number of poops on screen (0-4)

  // Game over state
  causeOfDeath: string | null;
}

// Action result returned by game engine
export interface ActionResult {
  success: boolean;
  message: string;
  statChanges: Partial<PetStats>;
  newState: PetState;
  animation?: AnimationType;
}

// Animation types for React component
export type AnimationType =
  | "idle"
  | "eating"
  | "playing"
  | "cleaning"
  | "sleeping"
  | "happy"
  | "sad"
  | "sick"
  | "calling"
  | "dying"
  | "hatching"
  | "evolving"
  | "refusing"
  | "celebrating";

// Game configuration
export interface GameConfig {
  // Time (in ms) for each life stage
  stagedurations: Record<LifeStage, number>;

  // Stat decay rates (points per minute)
  decayRates: {
    hunger: number;
    happiness: number;
    energy: number;
    cleanliness: number;
  };

  // Thresholds for various conditions
  thresholds: {
    hungry: number; // Below this = hungry
    sad: number; // Below this = sad
    tired: number; // Below this = needs sleep
    dirty: number; // Below this = needs cleaning
    sick: number; // Health below this = sick
    critical: number; // Below this = danger
    death: number; // Below this = death
    overfed: number; // Above this = overfed
  };
}

// Save data format
export interface SaveData {
  version: number;
  pet: PetState;
  createdAt: number;
  updatedAt: number;
}

// Command parsed from natural language
export interface GameCommand {
  action: Action | "status" | "help" | "reset" | "name";
  parameter?: string;
}
