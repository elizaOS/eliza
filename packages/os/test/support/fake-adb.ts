// spec/os/update/operator.md, "Story: Update a device by cable"; spec/os/image/verification.md, "Story: Know whether a booted image is what I staged"; spec/os/image/qualification.md, "Story: Qualify a device read-only"
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Tool = "adb" | "fastboot";

export type DeviceMode = "device" | "recovery" | "sideload" | "rescue" | "bootloader" | "fastbootd" | "offline" | "unauthorized" | "absent";

export interface Answer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
}

export interface Image {
  readonly props: Readonly<Record<string, string>>;
  readonly selinux: "Enforcing" | "Permissive";
}

export interface Scripted {
  readonly tool: Tool;
  readonly args: readonly string[];
  readonly answer: Answer;
  readonly become?: DeviceMode;
}

export interface Device {
  readonly serial: string;
  readonly mode: DeviceMode;
  readonly image: Image;
  readonly variables: Readonly<Record<string, string>>;
  readonly scripted: readonly Scripted[];
  readonly boots: readonly Image[];
  readonly sideloaded: readonly string[];
}

export interface Call {
  readonly tool: Tool;
  readonly args: readonly string[];
}

export interface FakeAdb {
  readonly adb: string;
  readonly fastboot: string;
  readonly directory: string;
  calls(): Call[];
  device(): Device;
  set(change: Partial<Device>): void;
}

export interface AdbServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

type Outcome = { readonly answer: Answer; readonly device: Device };

const ADB_VISIBLE: readonly DeviceMode[] = ["device", "recovery", "sideload", "rescue", "offline", "unauthorized"];
const FASTBOOT_VISIBLE: readonly DeviceMode[] = ["bootloader", "fastbootd"];
const ANDROID_SHELL: readonly DeviceMode[] = ["device", "recovery", "rescue"];

const ok = (stdout = ""): Answer => ({ stdout, status: 0 });
const failed = (stderr: string): Answer => ({ stderr, status: 1 });

export function device(serial: string, change: Partial<Omit<Device, "serial">> = {}): Device {
  return {
    serial,
    mode: "device",
    image: { props: { "sys.boot_completed": "1" }, selinux: "Enforcing" },
    variables: {},
    scripted: [],
    boots: [],
    sideloaded: [],
    ...change,
  };
}

function booted(current: Device): Device {
  const [next, ...rest] = current.boots;
  return next ? { ...current, mode: "device", image: next, boots: rest } : { ...current, mode: "device" };
}

function rebooted(current: Device, target: string | undefined): Device {
  switch (target) {
    case undefined: return booted(current);
    case "bootloader": return { ...current, mode: "bootloader" };
    case "fastboot": return { ...current, mode: "fastbootd" };
    case "recovery": return { ...current, mode: "recovery" };
    case "sideload": return { ...current, mode: "sideload" };
    default: return current;
  }
}

const getprop = (image: Image) => Object.entries(image.props).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `[${key}]: [${value}]\n`).join("");

function shell(current: Device, command: readonly string[]): Outcome {
  const [program, ...rest] = command;
  if (!ANDROID_SHELL.includes(current.mode)) return { answer: failed(`error: device '${current.serial}' not found`), device: current };
  switch (program) {
    case "getprop": return { answer: ok(rest[0] === undefined ? getprop(current.image) : `${current.image.props[rest[0]] ?? ""}\n`), device: current };
    case "getenforce": return { answer: ok(`${current.image.selinux}\n`), device: current };
    default: return { answer: failed(`fake adb: unscripted shell ${command.join(" ")}`), device: current };
  }
}

function adbCommand(current: Device, args: readonly string[]): Outcome {
  const [command, ...rest] = args;
  if (command === "devices") {
    const listed = ADB_VISIBLE.includes(current.mode) ? `${current.serial}\t${current.mode}\n` : "";
    return { answer: ok(`List of devices attached\n${listed}\n`), device: current };
  }
  if (command !== "-s" || rest[0] !== current.serial || !ADB_VISIBLE.includes(current.mode))
    return { answer: failed(`error: device '${command === "-s" ? rest[0] : ""}' not found`), device: current };
  const [verb, ...operands] = rest.slice(1);
  if (current.mode === "offline" || current.mode === "unauthorized") return { answer: failed(`error: device ${current.mode}`), device: current };
  switch (verb) {
    case "get-state": return { answer: ok(`${current.mode}\n`), device: current };
    case "wait-for-device": return { answer: ok(), device: current };
    case "shell": return shell(current, operands.length === 1 ? (operands[0] ?? "").split(/\s+/) : operands);
    case "reboot": return { answer: ok(), device: rebooted(current, operands[0]) };
    case "sideload": {
      const file = operands[0] ?? "";
      if (current.mode !== "sideload") return { answer: failed("adb: sideload connection failed: closed"), device: current };
      if (!existsSync(file)) return { answer: failed(`adb: failed to stat file ${file}`), device: current };
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      return { answer: ok("Total xfer: 1.00x\n"), device: { ...current, mode: "recovery", sideloaded: [...current.sideloaded, digest] } };
    }
    default: return { answer: failed(`fake adb: unscripted ${rest.slice(1).join(" ")}`), device: current };
  }
}

function fastbootCommand(current: Device, args: readonly string[]): Outcome {
  const [command, ...rest] = args;
  const visible = FASTBOOT_VISIBLE.includes(current.mode);
  if (command === "devices") return { answer: ok(visible ? `${current.serial}\tfastboot\n` : ""), device: current };
  if (command !== "-s" || rest[0] !== current.serial || !visible) return { answer: failed("< waiting for any device >"), device: current };
  const [verb, ...operands] = rest.slice(1);
  const slot = verb?.startsWith("--set-active=") ? verb.slice("--set-active=".length) : verb === "set_active" ? operands[0] : undefined;
  if (slot !== undefined) return { answer: { stderr: "OKAY\n", status: 0 }, device: { ...current, variables: { ...current.variables, "current-slot": slot } } };
  switch (verb) {
    case "getvar": {
      const name = operands[0] ?? "";
      const value = current.variables[name];
      return { answer: value === undefined ? failed("getvar:" + name + " FAILED (remote: 'GetVar Variable Not found')\n") : { stderr: `${name}: ${value}\nFinished. Total time: 0.001s\n`, status: 0 }, device: current };
    }
    case "reboot": return { answer: { stderr: "Rebooting\n", status: 0 }, device: rebooted(current, operands[0]) };
    case "reboot-bootloader": return { answer: { stderr: "Rebooting into bootloader\n", status: 0 }, device: { ...current, mode: "bootloader" } };
    case "flashing": return operands[0] === "unlock" || operands[0] === "lock"
      ? { answer: { stderr: "OKAY\n", status: 0 }, device: { ...current, variables: { ...current.variables, unlocked: operands[0] === "unlock" ? "yes" : "no" } } }
      : { answer: failed("fastboot: usage: unknown flashing command"), device: current };
    default: return { answer: failed(`fake fastboot: unscripted ${rest.slice(1).join(" ")}`), device: current };
  }
}

export function answer(current: Device, tool: Tool, args: readonly string[]): Outcome {
  const scripted = current.scripted.find((entry) => entry.tool === tool && entry.args.length <= args.length && entry.args.every((arg, i) => args[i] === arg));
  if (scripted) return { answer: scripted.answer, device: scripted.become ? { ...current, mode: scripted.become } : current };
  return tool === "adb" ? adbCommand(current, args) : fastbootCommand(current, args);
}

const stateFile = (directory: string) => path.join(directory, "device.json");
const callsFile = (directory: string) => path.join(directory, "calls.jsonl");

export function fakeAdb(directory: string, initial: Device): FakeAdb {
  const self = fileURLToPath(import.meta.url);
  writeFileSync(stateFile(directory), JSON.stringify(initial));
  writeFileSync(callsFile(directory), "");
  const tool = (name: Tool) => {
    const file = path.join(directory, name);
    writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(self)} ${name} ${JSON.stringify(directory)} "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const read = (): Device => JSON.parse(readFileSync(stateFile(directory), "utf8")) as Device;
  return {
    adb: tool("adb"),
    fastboot: tool("fastboot"),
    directory,
    calls: () => readFileSync(callsFile(directory), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call),
    device: read,
    set: (change) => writeFileSync(stateFile(directory), JSON.stringify({ ...read(), ...change })),
  };
}

const frame = (text: string) => {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, "0")), body]);
};

export async function serveAdb(devices: readonly Device[]): Promise<AdbServer> {
  const sockets = new Set<net.Socket>();
  const held = new Map(devices.map((entry) => [entry.serial, entry]));
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    let transport: string | undefined;
    client.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = Number.parseInt(buffered.subarray(0, 4).toString("latin1"), 16);
        if (!Number.isSafeInteger(length) || buffered.length < 4 + length) return;
        const request = buffered.subarray(4, 4 + length).toString("utf8");
        buffered = buffered.subarray(4 + length);
        if (request === "host:version") client.end(Buffer.concat([Buffer.from("OKAY"), frame("0029")]));
        else if (request === "host:devices" || request === "host:devices-l")
          client.end(Buffer.concat([Buffer.from("OKAY"), frame([...held.values()].filter((entry) => ADB_VISIBLE.includes(entry.mode)).map((entry) => `${entry.serial}\t${entry.mode}\n`).join(""))]));
        else if (request.startsWith("host:transport:") && held.has(request.slice("host:transport:".length))) {
          transport = request.slice("host:transport:".length);
          client.write("OKAY");
        } else if (transport !== undefined && request.startsWith("shell:")) {
          const outcome = shell(held.get(transport)!, request.slice("shell:".length).split(/\s+/));
          held.set(transport, outcome.device);
          client.end(Buffer.concat([Buffer.from("OKAY"), Buffer.from(outcome.answer.stdout ?? outcome.answer.stderr ?? "")]));
        } else client.end(Buffer.concat([Buffer.from("FAIL"), frame(`fake adb server: unscripted ${request}`)]));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return {
    host: "127.0.0.1",
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function main([tool, directory, ...args]: string[]) {
  if ((tool !== "adb" && tool !== "fastboot") || directory === undefined) return 2;
  appendFileSync(callsFile(directory), `${JSON.stringify({ tool, args })}\n`);
  const outcome = answer(JSON.parse(readFileSync(stateFile(directory), "utf8")) as Device, tool, args);
  writeFileSync(stateFile(directory), JSON.stringify(outcome.device));
  process.stdout.write(outcome.answer.stdout ?? "");
  process.stderr.write(outcome.answer.stderr ?? "");
  return outcome.answer.status ?? 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
