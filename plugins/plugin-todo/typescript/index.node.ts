import { routes } from "./apis";
import todoPlugin from "./index";

const nodePlugin = {
  ...todoPlugin,
  routes,
};

export { nodePlugin as default };
