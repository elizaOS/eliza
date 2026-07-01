declare module "@lydell/node-pty" {
  import type { PtySpawn } from "../services/pty-types";

  export const spawn: PtySpawn | undefined;

  const nodePty: {
    spawn?: PtySpawn;
  };
  export default nodePty;
}
