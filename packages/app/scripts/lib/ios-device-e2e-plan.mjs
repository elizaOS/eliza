/**
 * Pure command planning for the physical iOS device e2e lane.
 *
 * The runner itself is all device side effects: build, sign, install, XCUITest
 * capture, and boot-trace pull. Keeping the argv parsing and command assembly
 * here lets tests pin the lane contract without needing macOS or a paired
 * phone.
 */

export function parseIosDeviceE2eArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const val = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  return {
    device: val("--device"),
    output: val("--output"),
    skipBuild: has("--skip-build"),
    noLaunch: has("--no-launch"),
    includeAppexes: has("--include-appexes"),
    noWait: has("--no-wait"),
    bundleId: val("--bundle-id"),
    identity: val("--identity"),
    derivedData: val("--derived-data"),
    configuration: val("--configuration"),
    onlyTesting: val("--only-testing"),
  };
}

function pushValue(args, flag, value) {
  if (value) args.push(flag, value);
}

export function buildPhysicalIosDevicePlan(flags, paths) {
  const deployArgs = [
    "scripts/ios-device-deploy.mjs",
    "--staging",
    paths.stagingDir,
  ];
  if (!flags.includeAppexes) deployArgs.push("--skip-appexes");
  if (flags.skipBuild) deployArgs.push("--skip-build");
  if (flags.noLaunch) deployArgs.push("--no-launch");
  pushValue(deployArgs, "--device", flags.device);
  pushValue(deployArgs, "--bundle-id", flags.bundleId);
  pushValue(deployArgs, "--identity", flags.identity);
  pushValue(deployArgs, "--derived-data", flags.derivedData);
  pushValue(deployArgs, "--configuration", flags.configuration);

  const captureArgs = [
    "scripts/ios-device-capture.mjs",
    "--platform",
    "device",
    "--output",
    paths.captureDir,
    "--app-path",
    paths.stagedApp,
    "--strict-gate",
    "--require-chat",
  ];
  pushValue(captureArgs, "--device", flags.device);
  pushValue(captureArgs, "--bundle-id", flags.bundleId);
  pushValue(captureArgs, "--only-testing", flags.onlyTesting);

  const logsArgs = [
    "scripts/ios-device-logs.mjs",
    "--no-console",
    "--pull-boot-trace",
    "--output",
    paths.bootTraceOutput,
  ];
  pushValue(logsArgs, "--device", flags.device);
  pushValue(logsArgs, "--bundle-id", flags.bundleId);

  return [
    {
      id: "deploy",
      label: "deploy physical iOS app",
      cmd: "node",
      args: deployArgs,
    },
    {
      id: "capture",
      label: "capture physical iOS boot",
      cmd: "node",
      args: captureArgs,
    },
    {
      id: "logs",
      label: "pull physical iOS boot trace",
      cmd: "node",
      args: logsArgs,
    },
  ];
}
