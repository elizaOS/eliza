/**
 * NOTE: This plugin aims to recreate classic ELIZA script behavior.
 * `doctor.json` is the canonical script data source.
 */

export type ElizaWord = string;

export interface ElizaScriptRule {
  /** Decomposition pattern, e.g. "* you remember *" or "* you @belief you *" */
  decomposition: string;
  /** Reassembly rules, cycled in-order. May include redirects like "=what" and directives like ":newkey". */
  reassembly: readonly string[];
}

export interface ElizaKeywordEntry {
  /** One keyword entry can cover multiple surface forms, e.g. ["dreamt", "dreamed"] */
  keyword: readonly ElizaWord[];
  /** Higher means higher precedence */
  precedence: number;
  /** Normal decomposition/reassembly rules */
  rules: readonly ElizaScriptRule[];
  /**
   * Optional MEMORY rules (in the classic script, these are defined under (MEMORY MY ...)).
   * If present, a memory is recorded when this keyword is selected.
   */
  memory?: readonly ElizaScriptRule[];
}

export type ElizaGroups = Readonly<Record<string, readonly ElizaWord[]>>;
export type ElizaReflections = Readonly<Record<ElizaWord, ElizaWord>>;
export type ElizaSubstitutions = Readonly<Record<ElizaWord, ElizaWord>>;

export interface ElizaDoctorJson {
  greetings: readonly string[];
  goodbyes: readonly string[];
  default: readonly string[];
  reflections: ElizaReflections;
  /**
   * Optional input-time substitution map (keyword "=" substitutions / normalization).
   * If absent, the engine falls back to a conservative subset.
   */
  substitutions?: ElizaSubstitutions;
  groups: ElizaGroups;
  keywords: readonly ElizaKeywordEntry[];
}

export interface ElizaSessionState {
  /** Deterministic 1..4 counter used for memory recall cadence. */
  limit: 1 | 2 | 3 | 4;
  /** Stored memory responses (FIFO). */
  memories: string[];
  /** Per (keyword+rule+decomp) pointer for cycling reassembly rules. */
  reassemblyIndex: Map<string, number>;
}
