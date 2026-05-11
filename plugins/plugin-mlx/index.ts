import { mlxPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export * from "./utils/detect";
export { mlxPlugin };

const defaultMlxPlugin = mlxPlugin;

export default defaultMlxPlugin;
