/** Holds a loopback port until its owned child server is ready to bind. */
import { type AddressInfo, createServer } from "node:net";

export async function reserveStackPort(port = 0): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  let release: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    release: () => {
      release ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return release;
    },
  };
}
