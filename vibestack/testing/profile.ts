/** Fixed exploration profiles shared by Vitest and the spec command. */
export type TestProfile = "normal" | "nightly";

export const profiles = Object.freeze({
  normal: Object.freeze({ runs: 1_000, seed: 1 }),
  nightly: Object.freeze({ runs: 20_000, seed: 2 }),
});

export const profile = (name: TestProfile = "normal") => profiles[name];
