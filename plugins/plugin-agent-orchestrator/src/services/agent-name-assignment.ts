/**
 * Sub-agent name assignment.
 *
 * Every spawned sub-agent is given a real, distinct person-name — the way the
 * main agent is named — so an operator can tell workers apart and the agent
 * knows its own identity (the name is woven into the goal prompt by
 * {@link buildGoalPrompt}). This is the single place that decides that name, so
 * the orchestrator-task spawn path and the direct `/api/coding-agents/spawn`
 * route stay consistent.
 *
 * The pool mirrors `AGENT_NAME_POOL` in `@elizaos/agent`'s first-run flow, but
 * is owned locally: this plugin depends only on `@elizaos/core`, and
 * `@elizaos/agent` already depends on this plugin, so importing the agent
 * package here would close a dependency cycle and tie sub-agent naming to the
 * agent package's build artifact. The pool is pure, dependency-free data, so a
 * local copy is the correct seam.
 *
 * Precedence:
 *  1. An explicit, human-provided label always wins — never overwrite a user's
 *     deliberate choice.
 *  2. Otherwise assign a pooled person-name, unique among the names already in
 *     use by live sibling sessions and distinct from the running agent's own
 *     name, so a sub-agent is never confused with the orchestrator.
 *
 * @module services/agent-name-assignment
 */

/** Person-names a spawned sub-agent can be given. Kept in sync with the
 * `@elizaos/agent` first-run pool (Touhou cast) so workers feel like part of the
 * same family as the main agent. */
const SUB_AGENT_NAME_POOL: readonly string[] = [
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

/**
 * Pick a pooled name not present in `exclude` (case-insensitive). When every
 * pooled name is taken the pool is exhausted, so a numeric suffix is appended to
 * the first pooled name — an explicit, intended fallback that guarantees a
 * non-empty, distinct result rather than crashing or returning "".
 */
export function pickSubAgentName(exclude: readonly string[] = []): string {
  const taken = new Set(exclude.map((name) => name.trim().toLowerCase()));
  const available = SUB_AGENT_NAME_POOL.filter(
    (name) => !taken.has(name.toLowerCase()),
  );
  if (available.length > 0) {
    const index = Math.floor(Math.random() * available.length);
    return available[index] as string;
  }

  const base = SUB_AGENT_NAME_POOL[0] as string;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export interface AssignAgentNameInput {
  /** A human-provided label (e.g. the "Add agent" form field). When present and
   * non-empty it is kept verbatim. */
  explicitLabel?: string;
  /** Names already taken by live sibling sessions on the same task. */
  activeNames: readonly string[];
  /** The running (parent) agent's name, excluded so a worker is never confused
   * with the orchestrator. */
  mainAgentName?: string;
}

/**
 * Resolve the final name for a sub-agent at spawn time. Used both as the
 * session `label` and as the `agentName` passed into the goal prompt, so the
 * displayed name and the identity the agent is told are always the same.
 */
export function assignAgentName(input: AssignAgentNameInput): string {
  const explicit = input.explicitLabel?.trim();
  if (explicit) {
    return explicit;
  }

  const exclude = [...input.activeNames];
  const mainName = input.mainAgentName?.trim();
  if (mainName) {
    exclude.push(mainName);
  }
  return pickSubAgentName(exclude);
}
