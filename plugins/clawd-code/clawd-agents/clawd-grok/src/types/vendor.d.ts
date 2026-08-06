declare module "@npmcli/arborist" {
  interface Node {
    name: string;
    version: string;
    path: string;
    edgesOut: Map<string, { to: Node | null }>;
  }

  interface ArboristOptions {
    path: string;
    binLinks?: boolean;
    progress?: boolean;
    savePrefix?: string;
    ignoreScripts?: boolean;
    registry?: string;
    [key: string]: unknown;
  }

  interface ReifyOptions {
    add: string[];
    save: boolean;
    saveType: "prod" | "dev" | "optional" | "peer";
  }

  class Arborist {
    constructor(options: ArboristOptions);
    loadActual(): Promise<void>;
    loadVirtual(options?: { filter?: (node: Node) => boolean }): Promise<Node | null>;
    reify(options?: ReifyOptions): Promise<Node>;
    querySelectorAll(query: string): Promise<Node[]>;
  }

  export default Arborist;
}
