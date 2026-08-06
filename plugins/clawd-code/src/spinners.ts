import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SpinnerVerbs {
  mode: string;
  verbs: string[];
}

export interface SpinnerPack {
  name: string;
  description: string;
  examples: string[];
  spinnerVerbs: SpinnerVerbs;
  attribution?: string;
  source?: string;
}

export interface SpinnerPackSummary {
  name: string;
  description: string;
  examples: string[];
  verbCount: number;
}

export interface SpinnerInstallResult {
  packName: string;
  settingsPath: string;
  verbCount: number;
}

const PACK_DESCRIPTIONS: Record<string, string> = {
  '90s-kid': '90s nostalgia',
  'blue-collar-dev': 'Trades and construction humor',
  'bob-ross': 'Happy little accidents',
  borat: 'Borat Sagdiyev',
  cat: 'Cat-themed',
  chaos: 'Absurdist and chaotic humor',
  coffee: 'Coffee and food themed',
  corporate: 'Corporate buzzwords and jargon',
  cowboy: 'Wild West and frontier',
  'darth-vader': "Star Wars' Sith Lord",
  detective: 'Noir detective style',
  developer: 'Programming and dev culture',
  gardening: 'Gardening and growing',
  'gordon-ramsay': 'Angry chef yelling at code',
  'gym-bro': 'Gym and fitness culture',
  'honest-no-filter': 'Brutally honest dev thoughts',
  'jack-sparrow': 'Chaotic pirate captain',
  meme: 'Internet memes and viral phrases',
  'michael-scott': "The Office's Michael Scott",
  minions: 'Minion-style humor',
  motivational: 'Hype and motivational phrases',
  ninja: 'Ninja and stealth',
  ocean: 'Ocean and underwater',
  panicker: 'Pure dev anxiety',
  philosophical: 'Deep thoughts and philosophy',
  pirate: 'Pirate speak',
  'retro-gaming': 'Retro gaming references',
  'sarcastic-ai': 'Self-aware AI humor',
  'sf-entrepreneur': 'San Francisco tech scene',
  shakespeare: 'Shakespearean and old English',
  'sherlock-holmes': 'Deductive reasoning',
  space: 'Space and sci-fi',
  startup: 'Startup culture',
  superhero: 'Superhero themed',
  'the-dude': "Big Lebowski's The Dude",
  therapist: 'Therapy speak and self-care',
  'time-traveler': 'Time travel and paradoxes',
  vibecoder: 'Vibe coding culture',
  vim: 'Vim editor enthusiasts',
  'walter-white': "Breaking Bad's Heisenberg",
  wholesome: 'Wholesome and cozy vibes',
  wizard: 'Fantasy and magic themed',
  yoda: "Star Wars' Jedi Master",
  zombie: 'Zombie apocalypse survival',
};

function defaultSpinnersDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..', 'spinners');
}

export function getSpinnersDir(): string {
  return process.env.CLAWD_SPINNERS_DIR ? resolve(process.env.CLAWD_SPINNERS_DIR) : defaultSpinnersDir();
}

export function getSpinnerSettingsPath(): string {
  if (process.env.CLAWD_SPINNER_SETTINGS_PATH) {
    return resolve(process.env.CLAWD_SPINNER_SETTINGS_PATH);
  }

  const clawdPath = resolve(homedir(), '.clawd', 'settings.json');
  const claudePath = resolve(homedir(), '.claude', 'settings.json');
  return existsSync(clawdPath) || !existsSync(claudePath) ? clawdPath : claudePath;
}

function normalizePackName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.json$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid spinner pack name: ${name}`);
  }
  return normalized;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read JSON from ${path}: ${message}`);
  }
}

function parseSpinnerPack(name: string, raw: unknown): SpinnerPack {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Spinner pack ${name} must be a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  const spinnerVerbs = record.spinnerVerbs;
  if (!spinnerVerbs || typeof spinnerVerbs !== 'object') {
    throw new Error(`Spinner pack ${name} is missing spinnerVerbs.`);
  }
  const verbRecord = spinnerVerbs as Record<string, unknown>;
  const verbs = verbRecord.verbs;
  if (!Array.isArray(verbs) || verbs.some((verb) => typeof verb !== 'string' || !verb.trim())) {
    throw new Error(`Spinner pack ${name} must contain non-empty string verbs.`);
  }

  const normalizedVerbs = verbs.map((verb) => verb.trim());
  return {
    name,
    description: PACK_DESCRIPTIONS[name] ?? '',
    examples: normalizedVerbs.slice(0, 2),
    spinnerVerbs: {
      mode: typeof verbRecord.mode === 'string' && verbRecord.mode.trim() ? verbRecord.mode.trim() : 'replace',
      verbs: normalizedVerbs,
    },
    attribution: typeof record._attribution === 'string' ? record._attribution : undefined,
    source: typeof record._source === 'string' ? record._source : undefined,
  };
}

export function loadSpinnerPack(name: string, spinnersDir = getSpinnersDir()): SpinnerPack {
  const packName = normalizePackName(name);
  const path = resolve(spinnersDir, `${packName}.json`);
  if (!existsSync(path)) {
    throw new Error(`Unknown spinner pack: ${packName}`);
  }
  return parseSpinnerPack(packName, readJsonFile(path));
}

export function listSpinnerPacks(spinnersDir = getSpinnersDir()): SpinnerPackSummary[] {
  if (!existsSync(spinnersDir)) return [];

  return readdirSync(spinnersDir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'metadata.json')
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => {
      const pack = loadSpinnerPack(entry, spinnersDir);
      return {
        name: pack.name,
        description: pack.description,
        examples: pack.examples,
        verbCount: pack.spinnerVerbs.verbs.length,
      };
    });
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const parsed = readJsonFile(settingsPath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file must be a JSON object: ${settingsPath}`);
  }
  return parsed as Record<string, unknown>;
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function installSpinnerPack(
  name: string,
  options: { spinnersDir?: string; settingsPath?: string } = {},
): SpinnerInstallResult {
  const pack = loadSpinnerPack(name, options.spinnersDir);
  const settingsPath = options.settingsPath ? resolve(options.settingsPath) : getSpinnerSettingsPath();
  const settings = readSettings(settingsPath);
  settings.spinnerVerbs = pack.spinnerVerbs;
  writeSettings(settingsPath, settings);
  return {
    packName: pack.name,
    settingsPath,
    verbCount: pack.spinnerVerbs.verbs.length,
  };
}

export function removeSpinnerPack(options: { settingsPath?: string } = {}): { settingsPath: string; removed: boolean } {
  const settingsPath = options.settingsPath ? resolve(options.settingsPath) : getSpinnerSettingsPath();
  const settings = readSettings(settingsPath);
  const removed = Object.prototype.hasOwnProperty.call(settings, 'spinnerVerbs');
  delete settings.spinnerVerbs;
  writeSettings(settingsPath, settings);
  return { settingsPath, removed };
}

export function getInstalledSpinnerVerbs(
  options: { settingsPath?: string } = {},
): { settingsPath: string; spinnerVerbs?: SpinnerVerbs } {
  const settingsPath = options.settingsPath ? resolve(options.settingsPath) : getSpinnerSettingsPath();
  const settings = readSettings(settingsPath);
  const value = settings.spinnerVerbs;
  if (!value || typeof value !== 'object') return { settingsPath };
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.verbs) || record.verbs.some((verb) => typeof verb !== 'string')) {
    return { settingsPath };
  }
  return {
    settingsPath,
    spinnerVerbs: {
      mode: typeof record.mode === 'string' ? record.mode : 'replace',
      verbs: record.verbs,
    },
  };
}
