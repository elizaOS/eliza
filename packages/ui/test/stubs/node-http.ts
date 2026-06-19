// Stub for `node:http` in the Storybook browser catalog. Networking never runs
// during a render; export the names the reachable chain imports (default plus
// `ServerResponse`) so module init succeeds, throwing only if actually used.
const notAvailable = (name: string) => {
  throw new Error(`node:http stub cannot ${name} in Storybook`);
};

export class ServerResponse {}
export class IncomingMessage {}
export class Agent {}
export class Server {}
export const request = () => notAvailable("request");
export const get = () => notAvailable("get");
export const createServer = () => notAvailable("createServer");
export const METHODS: string[] = [];
export const STATUS_CODES: Record<number, string> = {};
export const globalAgent = new Agent();

export default {
  ServerResponse,
  IncomingMessage,
  Agent,
  Server,
  request,
  get,
  createServer,
  METHODS,
  STATUS_CODES,
  globalAgent,
};
