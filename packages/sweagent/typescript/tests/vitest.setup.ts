import { jest as jestShim } from "./jest-globals";

if (!("jest" in globalThis)) {
  (globalThis as typeof globalThis & { jest: typeof jestShim }).jest = jestShim;
}
