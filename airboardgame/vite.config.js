import { defineConfig } from "vite";
import analyze from "rollup-plugin-analyzer";
import reactRefresh from "@vitejs/plugin-react-refresh";
import dotenv from "dotenv";
dotenv.config();

const useProxy = process.env.VITE_USE_PROXY;
const server = process.env.VITE_API_ENDPOINT;
const socketServer = process.env.VITE_SOCKET_URL;
const siteId = process.env.VITE_RICOCHET_SITEID;

const checkDeprecatedVars = () => {
  const deprecatedVars = [
    "API_ENDPOINT",
    "SOCKET_URL",
    "SOCKET_PATH",
    "NO_WELCOME",
  ];
  const toBeFixed = deprecatedVars.map((variable) => {
    if (
      process.env[`REACT_APP_${variable}`] &&
      !process.env[`VITE_${variable}`]
    ) {
      console.log(
        `ERR! you have to migrate env variable REACT_APP_${variable} -> VITE_${variable}`
      );
      return true;
    }
    return false;
  });
  if (toBeFixed.some((v) => v)) {
    console.log(
      "ERR! Please fix error above to be able to start the server!\n\n"
    );
    process.exit(1);
  }
};

checkDeprecatedVars();

if (!siteId) {
  console.log(
    "ERR! You must define a VITE_RICOCHET_SITEID environment variable."
  );
  process.exit(1);
}

let proxy = {};

if (useProxy) {
  console.log("Proxy backend...");
  proxy = {
    server: {
      port: 3001,
      proxy: {
        "/socket.io": socketServer
          .replace("https", "wss")
          .replace("http", "ws"),
        "/file": server,
        [`/${siteId}`]: server,
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    reactRefresh(),
    analyze({ summaryOnly: true, hideDeps: true, limit: 20 }),
  ],
  build: {
    sourcemap: true,
  },
  server: {
    port: 3001,
  },
  ...proxy,
});
