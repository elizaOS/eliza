export default class GraphRAGError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = "GraphRAGError";
    }
}
