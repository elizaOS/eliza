import path from "path";
import { merge } from "webpack-merge";
import common from "./webpack.common.js";
import LocalTunnelPlugin from "webpack-plugin-localtunnel";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const prefix =
  process.env.TUNNEL_PREFIX || Math.random().toString().substring(2, 10);

export default merge(common, {
  mode: "development",
  watchOptions: {
    ignored: ["node_modules/**"],
  },
  devServer: {
    contentBase: path.join(dirname, "dist"),
    public: prefix + "-ricochet.loca.lt",
    compress: true,
    allowedHosts: [".loca.lt"],
    port: 9000,
  },
  plugins: [new LocalTunnelPlugin({ subdomain: prefix + "-ricochet" })],
});
