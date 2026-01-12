/**
 * Elizagotchi Game Engine
 *
 * Core game logic for the virtual pet, implementing all Tamagotchi mechanics.
 */

import type {
  Action,
  ActionResult,
  AnimationType,
  EvolutionData,
  GameCommand,
  GameConfig,
  LifeStage,
  Mood,
  Personality,
  PetState,
  PetStats,
} from "./types";

// ============================================================================
// GAME CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: GameConfig = {
  // Stage durations in milliseconds (accelerated for demo - real Tamagotchi used days)
  stagedurations: {
    egg: 60_000, // 1 minute
    baby: 180_000, // 3 minutes
    child: 300_000, // 5 minutes
    teen: 600_000, // 10 minutes
    adult: 1_800_000, // 30 minutes
    elder: 3_600_000, // 60 minutes until natural death
    dead: Infinity,
  },

  // Points lost per minute
  decayRates: {
    hunger: 2.0,
    happiness: 1.5,
    energy: 1.0,
    cleanliness: 0.8,
  },

  thresholds: {
    hungry: 40,
    sad: 35,
    tired: 25,
    dirty: 30,
    sick: 30,
    critical: 15,
    death: 0,
    overfed: 95,
  },
};

// ============================================================================
// INITIAL STATE
// ============================================================================

function createInitialStats(): PetStats {
  return {
    hunger: 50,
    happiness: 50,
    health: 100,
    energy: 100,
    cleanliness: 100,
    discipline: 50,
  };
}

function createInitialEvolution(): EvolutionData {
  return {
    careScore: 50,
    missedCare: 0,
    sickCount: 0,
    overfeedings: 0,
    playCount: 0,
    disciplineCount: 0,
  };
}

export function createNewPet(name: string = "Elizagotchi"): PetState {
  const now = Date.now();
  return {
    name,
    stage: "egg",
    mood: "neutral",
    stats: createInitialStats(),
    evolution: createInitialEvolution(),
    personality: "normal",

    birthTime: now,
    lastUpdate: now,
    stageStartTime: now,
    lastFed: now,
    lastPlayed: now,
    lastCleaned: now,
    lastSlept: now,

    isSick: false,
    isSleeping: false,
    lightsOn: true,
    needsAttention: false,
    poop: 0,

    causeOfDeath: null,
  };
}

// ============================================================================
// STAT MANAGEMENT
// ============================================================================

function clampStat(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function updateStats(stats: PetStats, changes: Partial<PetStats>): PetStats {
  return {
    hunger: clampStat(stats.hunger + (changes.hunger || 0)),
    happiness: clampStat(stats.happiness + (changes.happiness || 0)),
    health: clampStat(stats.health + (changes.health || 0)),
    energy: clampStat(stats.energy + (changes.energy || 0)),
    cleanliness: clampStat(stats.cleanliness + (changes.cleanliness || 0)),
    discipline: clampStat(stats.discipline + (changes.discipline || 0)),
  };
}

// ============================================================================
// MOOD CALCULATION
// ============================================================================

function calculateMood(state: PetState): Mood {
  if (state.stage === "dead") return "dead";
  if (state.isSleeping) return "sleeping";
  if (state.isSick) return "sick";

  const { stats } = state;
  const config = DEFAULT_CONFIG;

  // Check critical conditions
  if (stats.hunger < config.thresholds.critical) return "hungry";
  if (stats.cleanliness < config.thresholds.critical) return "dirty";
  if (stats.health < config.thresholds.sick) return "sick";

  // Check negative moods
  if (stats.hunger < config.thresholds.hungry) return "hungry";
  if (stats.happiness < config.thresholds.sad) return "sad";
  if (stats.cleanliness < config.thresholds.dirty) return "dirty";

  // Check positive moods
  const avgStats =
    (stats.hunger +
      stats.happiness +
      stats.health +
      stats.energy +
      stats.cleanliness) /
    5;
  if (avgStats > 80) return "happy";
  if (avgStats > 60) return "content";

  return "neutral";
}

// ============================================================================
// EVOLUTION & LIFE STAGES
// ============================================================================

function getNextStage(current: LifeStage): LifeStage {
  const progression: Record<LifeStage, LifeStage> = {
    egg: "baby",
    baby: "child",
    child: "teen",
    teen: "adult",
    adult: "elder",
    elder: "dead",
    dead: "dead",
  };
  return progression[current];
}

function calculatePersonality(evolution: EvolutionData): Personality {
  const { careScore, sickCount, missedCare } = evolution;

  if (careScore > 80 && sickCount < 2 && missedCare < 5) return "angel";
  if (sickCount > 5) return "sickly";
  if (missedCare > 10 || careScore < 30) return "rebel";
  return "normal";
}

function checkEvolution(state: PetState): PetState {
  if (state.stage === "dead") return state;

  const config = DEFAULT_CONFIG;
  const timeInStage = Date.now() - state.stageStartTime;
  const stageDuration = config.stagedurations[state.stage];

  if (timeInStage >= stageDuration) {
    const nextStage = getNextStage(state.stage);

    if (nextStage === "dead") {
      return {
        ...state,
        stage: "dead",
        mood: "dead",
        causeOfDeath: "Passed away peacefully of old age",
      };
    }

    // Update personality on evolution
    const personality = calculatePersonality(state.evolution);

    return {
      ...state,
      stage: nextStage,
      personality,
      stageStartTime: Date.now(),
      // Give a boost on evolution
      stats: updateStats(state.stats, {
        happiness: 20,
        health: 10,
      }),
    };
  }

  return state;
}

// ============================================================================
// TIME-BASED UPDATES (STAT DECAY)
// ============================================================================

export function tickUpdate(state: PetState): PetState {
  if (state.stage === "dead" || state.stage === "egg") return state;

  const now = Date.now();
  const elapsed = (now - state.lastUpdate) / 60_000; // Minutes elapsed
  const config = DEFAULT_CONFIG;

  // Don't decay if sleeping (except energy recharges)
  if (state.isSleeping) {
    const energyGain = elapsed * 5; // Gain energy while sleeping
    const newStats = updateStats(state.stats, { energy: energyGain });

    // Wake up when fully rested
    if (newStats.energy >= 100) {
      return {
        ...state,
        stats: newStats,
        isSleeping: false,
        lastUpdate: now,
        mood: calculateMood({ ...state, isSleeping: false }),
      };
    }

    return {
      ...state,
      stats: newStats,
      lastUpdate: now,
    };
  }

  // Apply decay
  const newStats = updateStats(state.stats, {
    hunger: -elapsed * config.decayRates.hunger,
    happiness: -elapsed * config.decayRates.happiness,
    energy: -elapsed * config.decayRates.energy,
    cleanliness: -elapsed * config.decayRates.cleanliness,
  });

  // Poop accumulation (every ~3 minutes)
  let poop = state.poop;
  const timeSinceCleaned = (now - state.lastCleaned) / 60_000;
  const expectedPoops = Math.floor(timeSinceCleaned / 3);
  if (expectedPoops > poop && poop < 4) {
    poop = Math.min(4, expectedPoops);
  }

  // Check for sickness
  let isSick = state.isSick;
  let health = newStats.health;

  if (!isSick) {
    // Get sick if conditions are bad
    const sickChance =
      (poop > 2 ? 0.3 : 0) +
      (newStats.cleanliness < 20 ? 0.3 : 0) +
      (newStats.hunger < 20 ? 0.2 : 0);
    if (Math.random() < sickChance * elapsed) {
      isSick = true;
    }
  }

  // Health decay when sick
  if (isSick) {
    health = clampStat(health - elapsed * 2);
  }

  // Check for death
  if (health <= 0 || newStats.hunger <= 0) {
    return {
      ...state,
      stage: "dead",
      mood: "dead",
      causeOfDeath: health <= 0 ? "Died from illness" : "Died from starvation",
      stats: { ...newStats, health: 0 },
      lastUpdate: now,
    };
  }

  // Check for attention calls
  const needsAttention =
    newStats.hunger < config.thresholds.hungry ||
    newStats.happiness < config.thresholds.sad ||
    newStats.cleanliness < config.thresholds.dirty ||
    isSick;

  // Update evolution care score
  const evolution = { ...state.evolution };
  if (needsAttention && !state.needsAttention) {
    evolution.missedCare++;
    evolution.careScore = Math.max(0, evolution.careScore - 2);
  }

  let newState: PetState = {
    ...state,
    stats: { ...newStats, health },
    poop,
    isSick,
    needsAttention,
    evolution,
    lastUpdate: now,
  };

  // Check for evolution
  newState = checkEvolution(newState);

  // Recalculate mood
  newState.mood = calculateMood(newState);

  return newState;
}

// ============================================================================
// ACTIONS
// ============================================================================

export function performAction(state: PetState, action: Action): ActionResult {
  if (state.stage === "dead") {
    return {
      success: false,
      message: `${state.name} has passed away... 😢`,
      statChanges: {},
      newState: state,
      animation: "idle",
    };
  }

  const now = Date.now();
  const newState = { ...state };
  let message = "";
  let statChanges: Partial<PetStats> = {};
  let animation: AnimationType = "idle";
  let success = true;

  switch (action) {
    case "feed": {
      if (state.stage === "egg") {
        message = "The egg can't eat yet!";
        success = false;
        animation = "refusing";
        break;
      }

      if (state.isSleeping) {
        message = `${state.name} is sleeping! Let them rest.`;
        success = false;
        animation = "sleeping";
        break;
      }

      if (state.stats.hunger > DEFAULT_CONFIG.thresholds.overfed) {
        message = `${state.name} is too full to eat!`;
        success = false;
        animation = "refusing";
        newState.evolution.overfeedings++;
        break;
      }

      statChanges = { hunger: 30, happiness: 5 };
      newState.stats = updateStats(state.stats, statChanges);
      newState.lastFed = now;
      message = `${state.name} enjoyed the meal! 🍔`;
      animation = "eating";
      newState.evolution.careScore = Math.min(
        100,
        newState.evolution.careScore + 1,
      );
      break;
    }

    case "play": {
      if (state.stage === "egg") {
        message = "The egg can't play yet!";
        success = false;
        animation = "refusing";
        break;
      }

      if (state.isSleeping) {
        message = `${state.name} is sleeping! Let them rest.`;
        success = false;
        animation = "sleeping";
        break;
      }

      if (state.isSick) {
        message = `${state.name} is too sick to play. Give them medicine!`;
        success = false;
        animation = "sick";
        break;
      }

      if (state.stats.energy < 20) {
        message = `${state.name} is too tired to play!`;
        success = false;
        animation = "refusing";
        break;
      }

      statChanges = { happiness: 25, energy: -15, hunger: -10 };
      newState.stats = updateStats(state.stats, statChanges);
      newState.lastPlayed = now;
      newState.evolution.playCount++;
      newState.evolution.careScore = Math.min(
        100,
        newState.evolution.careScore + 2,
      );
      message = `${state.name} had a great time playing! 🎮`;
      animation = "playing";
      break;
    }

    case "clean": {
      if (state.stage === "egg") {
        message = "The egg is already clean!";
        success = false;
        animation = "refusing";
        break;
      }

      statChanges = { cleanliness: 100 - state.stats.cleanliness };
      newState.stats = updateStats(state.stats, statChanges);
      newState.poop = 0;
      newState.lastCleaned = now;
      newState.evolution.careScore = Math.min(
        100,
        newState.evolution.careScore + 1,
      );
      message = `${state.name} is now sparkling clean! ✨`;
      animation = "cleaning";
      break;
    }

    case "sleep": {
      if (state.stage === "egg") {
        message = "The egg is resting inside...";
        success = false;
        animation = "idle";
        break;
      }

      if (state.isSleeping) {
        message = `${state.name} is already sleeping! 💤`;
        success = false;
        animation = "sleeping";
        break;
      }

      if (!state.lightsOn) {
        newState.isSleeping = true;
        newState.lastSlept = now;
        message = `${state.name} fell asleep. Sweet dreams! 🌙`;
        animation = "sleeping";
      } else {
        message = "Turn off the lights first!";
        success = false;
        animation = "refusing";
      }
      break;
    }

    case "medicine": {
      if (!state.isSick) {
        message = `${state.name} doesn't need medicine!`;
        success = false;
        animation = "refusing";
        break;
      }

      statChanges = { health: 30 };
      newState.stats = updateStats(state.stats, statChanges);
      newState.isSick = false;
      newState.evolution.sickCount++;
      message = `${state.name} took the medicine and feels better! 💊`;
      animation = "happy";
      break;
    }

    case "discipline": {
      if (state.stage === "egg") {
        message = "You can't discipline an egg!";
        success = false;
        animation = "refusing";
        break;
      }

      if (state.needsAttention && !state.isSick && state.stats.hunger > 50) {
        // Pet was misbehaving, discipline is appropriate
        statChanges = { discipline: 15, happiness: -5 };
        newState.stats = updateStats(state.stats, statChanges);
        newState.needsAttention = false;
        newState.evolution.disciplineCount++;
        message = `${state.name} was disciplined and learned their lesson.`;
        animation = "sad";
      } else {
        // Discipline when not needed
        statChanges = { happiness: -15 };
        newState.stats = updateStats(state.stats, statChanges);
        message = `${state.name} didn't understand why they were scolded... 😢`;
        animation = "sad";
      }
      break;
    }

    case "light_toggle": {
      newState.lightsOn = !state.lightsOn;
      if (newState.lightsOn && newState.isSleeping) {
        // Wake up when lights come on
        newState.isSleeping = false;
        message = `Lights on! ${state.name} woke up. ☀️`;
      } else if (!newState.lightsOn) {
        message = "Lights off. Time for bed! 🌙";
      } else {
        message = "Lights on! ☀️";
      }
      animation = "idle";
      break;
    }
  }

  // Recalculate mood
  newState.mood = calculateMood(newState);

  return {
    success,
    message,
    statChanges,
    newState,
    animation,
  };
}

// ============================================================================
// EGG HATCHING
// ============================================================================

export function checkHatch(state: PetState): {
  hatched: boolean;
  newState: PetState;
} {
  if (state.stage !== "egg") {
    return { hatched: false, newState: state };
  }

  const timeAsEgg = Date.now() - state.stageStartTime;
  if (timeAsEgg >= DEFAULT_CONFIG.stagedurations.egg) {
    const newState: PetState = {
      ...state,
      stage: "baby",
      stageStartTime: Date.now(),
      mood: "happy",
    };
    return { hatched: true, newState };
  }

  return { hatched: false, newState: state };
}

// ============================================================================
// COMMAND PARSING
// ============================================================================

export function parseCommand(input: string): GameCommand | null {
  const text = input.toLowerCase().trim();

  // Feed variations
  if (
    /\b(feed|eat|food|hungry|meal|dinner|breakfast|lunch|snack)\b/.test(text)
  ) {
    return { action: "feed" };
  }

  // Play variations
  if (/\b(play|fun|game|ball|toy|exercise)\b/.test(text)) {
    return { action: "play" };
  }

  // Clean variations
  if (/\b(clean|wash|bath|shower|poop|dirty|mess)\b/.test(text)) {
    return { action: "clean" };
  }

  // Sleep variations
  if (/\b(sleep|rest|nap|tired|bed|night)\b/.test(text)) {
    return { action: "sleep" };
  }

  // Medicine variations
  if (/\b(medicine|heal|cure|sick|doctor|pill|treat)\b/.test(text)) {
    return { action: "medicine" };
  }

  // Discipline variations
  if (/\b(discipline|scold|punish|train|no|bad)\b/.test(text)) {
    return { action: "discipline" };
  }

  // Light toggle
  if (/\b(light|lamp|dark|bright)\b/.test(text)) {
    return { action: "light_toggle" };
  }

  // Status check
  if (/\b(status|stats|how|health|check|info)\b/.test(text)) {
    return { action: "status" };
  }

  // Help
  if (/\b(help|what|commands|options)\b/.test(text)) {
    return { action: "help" };
  }

  // Reset
  if (/\b(reset|restart|new|again)\b/.test(text)) {
    return { action: "reset" };
  }

  // Name
  const nameMatch = text.match(/\b(?:name|call)\s+(?:it|them|pet)?\s*(.+)/);
  if (nameMatch) {
    return { action: "name", parameter: nameMatch[1].trim() };
  }

  return null;
}

// ============================================================================
// STATUS FORMATTING
// ============================================================================

export function formatStatus(state: PetState): string {
  if (state.stage === "dead") {
    return (
      `💀 ${state.name} has passed away.\n` +
      `Cause: ${state.causeOfDeath}\n` +
      `Age: ${getAge(state)}\n` +
      `Say "reset" to start over with a new pet.`
    );
  }

  const { stats } = state;
  const bars = (value: number) => {
    const filled = Math.round(value / 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  return (
    `🐣 ${state.name} (${state.stage.toUpperCase()})\n` +
    `Age: ${getAge(state)}\n\n` +
    `🍔 Hunger:     ${bars(stats.hunger)} ${Math.round(stats.hunger)}%\n` +
    `😊 Happiness:  ${bars(stats.happiness)} ${Math.round(stats.happiness)}%\n` +
    `❤️ Health:     ${bars(stats.health)} ${Math.round(stats.health)}%\n` +
    `⚡ Energy:     ${bars(stats.energy)} ${Math.round(stats.energy)}%\n` +
    `✨ Clean:      ${bars(stats.cleanliness)} ${Math.round(stats.cleanliness)}%\n` +
    `📚 Discipline: ${bars(stats.discipline)} ${Math.round(stats.discipline)}%\n\n` +
    `Mood: ${state.mood} ${getMoodEmoji(state.mood)}\n` +
    (state.isSick ? "⚠️ SICK - Needs medicine!\n" : "") +
    (state.poop > 0 ? `💩 Poop count: ${state.poop}\n` : "") +
    (state.isSleeping ? "💤 Currently sleeping\n" : "") +
    (!state.lightsOn ? "🌙 Lights are off\n" : "")
  );
}

function getAge(state: PetState): string {
  const ms = Date.now() - state.birthTime;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function getMoodEmoji(mood: Mood): string {
  const emojis: Record<Mood, string> = {
    happy: "😄",
    content: "🙂",
    neutral: "😐",
    sad: "😢",
    angry: "😠",
    sick: "🤒",
    sleeping: "😴",
    hungry: "🍽️",
    dirty: "🧹",
    dead: "💀",
  };
  return emojis[mood];
}

export function getHelp(): string {
  return (
    `🎮 ELIZAGOTCHI COMMANDS:\n\n` +
    `🍔 "feed" - Feed your pet\n` +
    `🎮 "play" - Play with your pet\n` +
    `🧹 "clean" - Clean up messes\n` +
    `😴 "sleep" - Put your pet to bed (lights must be off)\n` +
    `💊 "medicine" - Give medicine when sick\n` +
    `📚 "discipline" - Discipline misbehavior\n` +
    `💡 "light" - Toggle lights on/off\n` +
    `📊 "status" - Check pet stats\n` +
    `🔄 "reset" - Start over with new pet\n\n` +
    `Keep your pet fed, happy, and clean to help them evolve!`
  );
}

// ============================================================================
// EXPORT CONFIGURATION
// ============================================================================

export const CONFIG = DEFAULT_CONFIG;
