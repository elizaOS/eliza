import path from "path";
import { merge } from "webpack-merge";
import common from "./webpack.common.js";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default merge(common, {
  mode: "development",
  watchOptions: {
    ignored: ["node_modules/**"],
  },
  devServer: {
    contentBase: path.join(dirname, "dist"),
    compress: true,
    port: 9000,
  },
});
