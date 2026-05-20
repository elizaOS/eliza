declare module '@dagrejs/dagre' {
  interface GraphOptions {
    directed?: boolean;
    multigraph?: boolean;
    compound?: boolean;
  }

  interface GraphLabel {
    rankdir?: string;
    nodesep?: number;
    ranksep?: number;
    marginx?: number;
    marginy?: number;
  }

  interface NodeLabel {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    [key: string]: unknown;
  }

  interface EdgeLabel {
    [key: string]: unknown;
  }

  class Graph {
    constructor(opts?: GraphOptions);
    setGraph(label: GraphLabel): void;
    setDefaultEdgeLabel(fn: () => EdgeLabel): void;
    setNode(name: string, label: NodeLabel): void;
    setEdge(source: string, target: string, label?: EdgeLabel): void;
    node(name: string): NodeLabel;
    graph(): GraphLabel;
  }

  const graphlib: {
    Graph: typeof Graph;
  };

  function layout(graph: Graph): void;

  const dagre: {
    graphlib: typeof graphlib;
    layout: typeof layout;
  };

  export default dagre;
}
