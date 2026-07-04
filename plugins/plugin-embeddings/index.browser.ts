/** Browser build entrypoint; re-exports the shared plugin implementation from src. */
import { embeddingsPlugin } from "./src/index";

export * from "./src/index";
export { embeddingsPlugin };

const defaultEmbeddingsPlugin = embeddingsPlugin;

export default defaultEmbeddingsPlugin;
