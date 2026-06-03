// Stub for `node:net` in the Storybook browser catalog. Imported as a default
// (`import net from "node:net"`); sockets never open during a render. Provide
// the surface so module init succeeds, throwing only if actually used.
const notAvailable = (name: string) => {
  throw new Error(`node:net stub cannot ${name} in Storybook`);
};

export class Socket {
  connect() {
    return notAvailable("Socket.connect");
  }
  on() {
    return this;
  }
  destroy() {
    return this;
  }
}
export class Server {}
export const createConnection = () => notAvailable("createConnection");
export const connect = () => notAvailable("connect");
export const createServer = () => notAvailable("createServer");
export const isIP = () => 0;
export const isIPv4 = () => false;
export const isIPv6 = () => false;

export default {
  Socket,
  Server,
  createConnection,
  connect,
  createServer,
  isIP,
  isIPv4,
  isIPv6,
};
