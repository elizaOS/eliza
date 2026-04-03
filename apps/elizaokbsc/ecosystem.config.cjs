const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "elizaokbsc",
      cwd: path.resolve(__dirname, "../.."),
      script: "bun",
      args: "--env-file=apps/elizaokbsc/.env run apps/elizaokbsc/src/index.ts",
      interpreter: "none",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
