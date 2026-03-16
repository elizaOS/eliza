/**
 * Shared pool of Japanese agent names for onboarding.
 *
 * Used by both the CLI first-run flow (eliza.ts) and the
 * web UI API server (api/server.ts).
 */

/** Pool of Japanese names to randomly sample from during onboarding. */
export const AGENT_NAME_POOL: readonly string[] = [
  "Reimu",
  "Sakuya",
  "Yukari",
  "Marisa",
  "Youmu",
  "Koakuma",
  "Reisen",
  "Yuyuko",
  "Aya",
  "Ran",
  "Sanae",
  "Suika",
  "Koishi",
  "Nue",
  "Chen",
  "Mokou",
  "Satori",
  "Remilia",
  "Suwako",
  "Momiji",
  "Tenshi",
  "Kaguya",
  "Komachi",
  "Nitori",
  "Charlotte",
  "Kasen",
  "Mima",
  "Yuuka",
  "Kogasa",
  "Rin",
  "Tewi",
  "Eirin",
  "Hina",
  "Kagerou",
  "Sumireko",
  "Kokoro",
  "Mamizou",
  "Rinnosuke",
  "Yumemi",
  "Akyuu",
  "Kanako",
  "Hatsune",
  "Shinki",
  "Shion",
  "Daiyousei",
  "Iku",
  "Miya",
  "Mai",
  "Meira",
  "Murasa",
  "Usagi",
  "Rei",
  "Yumi",
  "Miku",
  "Kira",
];

/** Pick `count` unique random names from the pool using Fisher-Yates shuffle. */
export function pickRandomNames(count: number): string[] {
  const clamped = Math.max(0, Math.min(count, AGENT_NAME_POOL.length));
  const pool = [...AGENT_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, clamped);
}
