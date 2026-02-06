import path from "path";
import dotenv from "dotenv";
import Dotenv from "dotenv-webpack";
import EncryptPlugin from "ricochetjs/encrypt-webpack-plugin";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: path.join(dirname, ".env"),
});

const SECRET_KEY = process.env.RICOCHET_SITE_KEY;

if (!SECRET_KEY) {
  console.log(
    "You must define a RICOCHET_SITE_KEY env variable.\n" +
      "If you don't have any key, please visit the Ricochet.js admin panel to create one."
  );
  process.exit(-1);
}

export default {
  entry: "./src/index.js",
  target: "node",
  devtool: false,
  output: {
    path: path.resolve(dirname, "../public"),
    filename: "ricochet.json",
    library: {
      type: "commonjs2",
    },
  },
  plugins: [
    new Dotenv(),
    new EncryptPlugin({
      key: SECRET_KEY,
    }),
  ],
};
