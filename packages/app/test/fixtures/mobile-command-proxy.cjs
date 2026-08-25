/** Deterministic native-tool boundary for the host-side mobile smoke tests. */
const fs = require("node:fs");
const path = require("node:path");

const command = path.basename(process.argv[2]);
const args = process.argv.slice(3);
if (process.env.FAKE_MOBILE_COMMAND_LOG) {
  fs.appendFileSync(
    process.env.FAKE_MOBILE_COMMAND_LOG,
    `${JSON.stringify({ command, args })}\n`,
  );
}

if (command === "xcrun") {
  if (args[0] !== "simctl") process.exit(2);
  if (args[1] === "list") {
    process.stdout.write(
      "    iPhone Unit (11111111-1111-1111-1111-111111111111) (Booted)\n",
    );
  } else if (args[1] === "get_app_container") {
    process.stdout.write(
      args[4] === "data"
        ? process.env.FAKE_IOS_DATA_CONTAINER
        : process.env.FAKE_IOS_APP_CONTAINER,
    );
  } else if (args[1] === "spawn" && args[3] === "defaults") {
    const operation = args[4];
    const key = args[6];
    const statePath = process.env.FAKE_DEFAULTS_STATE;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (operation === "export") process.stdout.write(JSON.stringify(state));
    if (operation === "write") {
      state[key] = args[8];
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    if (operation === "read") {
      if (!(key in state)) process.exit(1);
      process.stdout.write(String(state[key]));
    }
    if (operation === "delete") {
      delete state[key];
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
  } else if (args[1] === "io" && args[3] === "screenshot") {
    fs.writeFileSync(args[4], "screenshot");
  }
} else if (command === "plutil") {
  const source = args.at(-1);
  process.stdout.write(
    source === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(source, "utf8"),
  );
} else if (command === "adb") {
  if (args[0] === "devices") {
    process.stdout.write("List of devices attached\nemulator-unit\tdevice\n");
  } else if (args.includes("pm") && args.includes("path")) {
    process.stdout.write("package:/data/app/ai.elizaos.app/base.apk\n");
  } else if (args.includes("files/auth/local-agent-token")) {
    process.stdout.write("unit-token\n");
  } else if (args.includes("tcp:0")) {
    process.stdout.write("42000\n");
  }
}
