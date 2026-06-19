// Stub for `node:https` in the Storybook browser catalog. Only `request` is
// imported by the reachable chain; throw if it is ever actually called.
const notAvailable = (name: string) => {
  throw new Error(`node:https stub cannot ${name} in Storybook`);
};
export const request = () => notAvailable("request");
export const get = () => notAvailable("get");
export class Agent {}
export const globalAgent = new Agent();

export default { request, get, Agent, globalAgent };
