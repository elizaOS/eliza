/** Fixed exploration profiles shared by Vitest and the spec command. `explore` is the seconds Bombadil runs on a page, Chrome's start included. */
export type TestProfile = "normal" | "nightly";

export const profiles = Object.freeze({
  normal: Object.freeze({ runs: 1_000, seed: 1, explore: 60 }),
  nightly: Object.freeze({ runs: 20_000, seed: 2, explore: 300 }),
});

export const profile = (name: TestProfile = "normal") => profiles[name];
