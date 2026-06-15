// Stub for `node:dns/promises` in the Storybook browser catalog. The reachable
// chain imports `lookup`; DNS never resolves during a render, so return a
// benign loopback result rather than throwing (the value is unused).
export const lookup = async (hostname: string) => ({
  address: "127.0.0.1",
  family: 4,
});
export const resolve = async () => [] as string[];
export const resolve4 = async () => [] as string[];
export const resolve6 = async () => [] as string[];
export const reverse = async () => [] as string[];

export default { lookup, resolve, resolve4, resolve6, reverse };
