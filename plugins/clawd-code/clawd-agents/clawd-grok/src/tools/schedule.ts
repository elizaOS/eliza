import { spawn } from "child_process";
import { closeSync, promises as fs, openSync } from "fs";
import os from "os";
import path from "path";
import { getCurrentModel } from "../utils/settings";

function getSchedulesDirPath(): string {
  return path.join(getScheduleHomeBase(), ".grok", "schedules");
}

function getScheduleDaemonPidFilePath(): string {
  return path.join(getScheduleHomeBase(), ".grok", "daemon.pid");
}

let scheduleHomeBaseOverride: string | null = null;

function getScheduleHomeBase(): string {
  return scheduleHomeBaseOverride ?? os.homedir();
}

export interface StoredSchedule {
  id: string;
  name: string;
  instruction: string;
  cron?: string;
  model: string;
  directory: string;
  enabled: boolean;
  maxToolRounds: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateOptions {
  name: string;
  instruction: string;
  cron?: string;
  model?: string;
  directory?: string;
  maxToolRounds?: number;
}

export interface ScheduleDaemonStatus {
  running: boolean;
  pid: number | null;
}

export interface ScheduleDaemonStartResult {
  status: ScheduleDaemonStatus;
  pid: number | null;
  alreadyRunning: boolean;
}

export interface ScheduleDaemonStopResult {
  status: ScheduleDaemonStatus;
  pid: number | null;
  wasRunning: boolean;
}

export interface ScheduleCreateResult {
  schedule: StoredSchedule;
  daemonStatus: ScheduleDaemonStatus;
  startedPid: number | null;
}

interface HeadlessRunOptions {
  instruction: string;
  directory: string;
  model: string;
  maxToolRounds: number;
  logPath: string;
  env?: NodeJS.ProcessEnv;
}

interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface ParsedCronPart {
  start: number;
  end: number;
  step: number;
}

export class ScheduleManager {
  constructor(
    private readonly getCwd: () => string = () => process.cwd(),
    private readonly getModel: () => string = () => getCurrentModel(),
  ) {}

  async create(options: ScheduleCreateOptions): Promise<ScheduleCreateResult> {
    const name = options.name.trim();
    const instruction = options.instruction.trim();
    const cron = options.cron?.trim() || undefined;

    if (!name) {
      throw new Error("Schedule name is required.");
    }
    if (!instruction) {
      throw new Error("Schedule instruction is required.");
    }
    if (cron && !isValidCron(cron)) {
      throw new Error(`Invalid cron expression: ${cron}`);
    }

    const id = toScheduleId(name);
    if (!id) {
      throw new Error("Could not derive a valid schedule id from the provided name.");
    }

    const existing = await this.get(id);
    if (existing) {
      throw new Error(`A schedule named "${existing.name}" already exists.`);
    }

    const directory = await resolveScheduleDirectory(options.directory, this.getCwd());
    const model = (options.model?.trim() || this.getModel()).trim();
    const now = new Date().toISOString();
    const schedule: StoredSchedule = {
      id,
      name,
      instruction,
      ...(cron ? { cron } : {}),
      model,
      directory,
      enabled: true,
      maxToolRounds: options.maxToolRounds ?? 400,
      createdAt: now,
      updatedAt: now,
    };

    await writeScheduleRecord(schedule);

    let startedPid: number | null = null;
    if (!schedule.cron) {
      startedPid = await startDetachedHeadlessRun({
        instruction: schedule.instruction,
        directory: schedule.directory,
        model: schedule.model,
        maxToolRounds: schedule.maxToolRounds,
        logPath: getScheduleRunLogPath(schedule.id),
      });
      schedule.lastRunAt = now;
      schedule.updatedAt = now;
      await writeScheduleRecord(schedule);
    }

    return {
      schedule,
      daemonStatus: await getScheduleDaemonStatus(),
      startedPid,
    };
  }

  async list(): Promise<StoredSchedule[]> {
    const files = await listScheduleFiles();
    const items = await Promise.all(files.map((file) => readScheduleRecord(path.join(getSchedulesDirPath(), file))));
    return items
      .filter((item): item is StoredSchedule => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    return readScheduleRecord(getScheduleRecordPath(id));
  }

  async remove(id: string): Promise<StoredSchedule | null> {
    const schedule = await this.get(id);
    if (!schedule) {
      return null;
    }

    await fs.rm(getScheduleRecordPath(id), { force: true });
    await fs.rm(getScheduleLogDir(id), { recursive: true, force: true });
    return schedule;
  }

  async enable(id: string): Promise<StoredSchedule> {
    const schedule = await this.require(id);
    if (!schedule.cron) {
      throw new Error(`Schedule "${id}" is one-time only and cannot be enabled.`);
    }

    const next = { ...schedule, enabled: true, updatedAt: new Date().toISOString() };
    await writeScheduleRecord(next);
    return next;
  }

  async disable(id: string): Promise<StoredSchedule> {
    const schedule = await this.require(id);
    if (!schedule.cron) {
      throw new Error(`Schedule "${id}" is one-time only and cannot be disabled.`);
    }

    const next = { ...schedule, enabled: false, updatedAt: new Date().toISOString() };
    await writeScheduleRecord(next);
    return next;
  }

  async readLog(id: string, tail = 50): Promise<string> {
    const schedule = await this.require(id);
    const logPath = getScheduleRunLogPath(schedule.id);

    try {
      const content = await fs.readFile(logPath, "utf8");
      const lines = content.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
      if (lines.length === 0) {
        return `No log output yet for "${schedule.name}".`;
      }
      return lines.slice(-Math.max(1, tail)).join("\n");
    } catch {
      return `No log output yet for "${schedule.name}".`;
    }
  }

  async touchLastRunAt(id: string, at = new Date()): Promise<StoredSchedule> {
    const schedule = await this.require(id);
    const timestamp = at.toISOString();
    const next = {
      ...schedule,
      lastRunAt: timestamp,
      updatedAt: timestamp,
    };
    await writeScheduleRecord(next);
    return next;
  }

  async getDaemonStatus(): Promise<ScheduleDaemonStatus> {
    return getScheduleDaemonStatus();
  }

  async startDaemon(): Promise<ScheduleDaemonStartResult> {
    return startScheduleDaemon(this.getCwd());
  }

  async stopDaemon(): Promise<ScheduleDaemonStopResult> {
    return stopScheduleDaemon();
  }

  private async require(id: string): Promise<StoredSchedule> {
    const schedule = await this.get(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" not found.`);
    }
    return schedule;
  }
}

export async function ensureSchedulesDir(): Promise<string> {
  const dir = getSchedulesDirPath();
  try {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    scheduleHomeBaseOverride ??= path.join(os.tmpdir(), "grok-home");
    const fallbackDir = getSchedulesDirPath();
    await fs.mkdir(fallbackDir, { recursive: true });
    return fallbackDir;
  }
}

export function getScheduleRecordPath(id: string): string {
  const resolved = path.join(getSchedulesDirPath(), `${id}.json`);
  assertInsideSchedulesDir(resolved);
  return resolved;
}

export function getScheduleLogDir(id: string): string {
  const resolved = path.join(getSchedulesDirPath(), id);
  assertInsideSchedulesDir(resolved);
  return resolved;
}

function assertInsideSchedulesDir(resolved: string): void {
  const schedulesDir = path.resolve(getSchedulesDirPath());
  const normalized = path.resolve(resolved);
  if (!normalized.startsWith(`${schedulesDir}${path.sep}`) && normalized !== schedulesDir) {
    throw new Error("Invalid schedule id: path traversal detected.");
  }
}

export function getScheduleRunLogPath(id: string): string {
  return path.join(getScheduleLogDir(id), "run.log");
}

export function getScheduleDaemonPidPath(): string {
  return getScheduleDaemonPidFilePath();
}

export async function writeScheduleDaemonPid(pid: number): Promise<void> {
  const pidPath = getScheduleDaemonPidFilePath();
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, `${pid}\n`, "utf8");
}

export async function removeScheduleDaemonPid(): Promise<void> {
  await fs.rm(getScheduleDaemonPidFilePath(), { force: true });
}

export async function getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
  try {
    const raw = (await fs.readFile(getScheduleDaemonPidFilePath(), "utf8")).trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      await removeScheduleDaemonPid();
      return { running: false, pid: null };
    }
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      await removeScheduleDaemonPid();
      return { running: false, pid: null };
    }
  } catch {
    return { running: false, pid: null };
  }
}

export async function startScheduleDaemon(cwd = process.cwd()): Promise<ScheduleDaemonStartResult> {
  const existing = await getScheduleDaemonStatus();
  if (existing.running) {
    return {
      status: existing,
      pid: existing.pid,
      alreadyRunning: true,
    };
  }

  const child = spawn(process.execPath, [...resolveCliArgs(), "daemon"], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FORCE_COLOR: "0", CLAWD_DAEMON_CHILD: "1" },
  });
  child.unref();

  const status = await waitForDaemonStatus(child.pid ?? null, true);
  return {
    status,
    pid: status.pid ?? child.pid ?? null,
    alreadyRunning: false,
  };
}

export async function stopScheduleDaemon(): Promise<ScheduleDaemonStopResult> {
  const existing = await getScheduleDaemonStatus();
  if (!existing.running || !existing.pid) {
    return {
      status: { running: false, pid: null },
      pid: null,
      wasRunning: false,
    };
  }

  if (existing.pid === process.pid) {
    throw new Error("Refusing to stop the current process as the schedule daemon.");
  }

  try {
    process.kill(existing.pid, "SIGTERM");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("ESRCH")) {
      throw err;
    }
  }

  let status = await waitForDaemonStatus(existing.pid, false);
  if (status.running) {
    try {
      process.kill(existing.pid, "SIGKILL");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("ESRCH")) {
        throw err;
      }
    }
    status = await waitForDaemonStatus(existing.pid, false, 10, 100);
  }

  if (status.running) {
    throw new Error(`Failed to stop schedule daemon pid ${existing.pid}.`);
  }

  await removeScheduleDaemonPid();
  return {
    status,
    pid: existing.pid,
    wasRunning: true,
  };
}

export async function listStoredSchedules(): Promise<StoredSchedule[]> {
  return new ScheduleManager().list();
}

export async function readStoredSchedule(id: string): Promise<StoredSchedule | null> {
  return readScheduleRecord(getScheduleRecordPath(id));
}

export async function writeStoredSchedule(schedule: StoredSchedule): Promise<void> {
  await writeScheduleRecord(schedule);
}

export async function startDetachedHeadlessRun(options: HeadlessRunOptions): Promise<number | null> {
  await fs.mkdir(path.dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "a");
  try {
    const child = spawn(process.execPath, [...resolveCliArgs(), ...buildHeadlessCliArgs(options)], {
      cwd: options.directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, FORCE_COLOR: "0", ...options.env },
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(logFd);
  }
}

export function buildHeadlessCliArgs(options: Omit<HeadlessRunOptions, "logPath" | "env">): string[] {
  return [
    "--directory",
    options.directory,
    "--prompt",
    options.instruction,
    "--model",
    options.model,
    "--max-tool-rounds",
    String(options.maxToolRounds),
  ];
}

export function resolveCliArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Could not resolve the CLI entrypoint.");
  }
  return [entry];
}

async function waitForDaemonStatus(
  pid: number | null,
  shouldBeRunning: boolean,
  attempts = 20,
  delayMs = 50,
): Promise<ScheduleDaemonStatus> {
  let status = await getScheduleDaemonStatus();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (shouldBeRunning ? status.running : !status.running) {
      break;
    }
    await sleep(delayMs);
    status = await getScheduleDaemonStatus();
    if (pid && status.pid === pid && shouldBeRunning) {
      break;
    }
  }
  return status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toScheduleId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    return "";
  }
  return id;
}

export function isValidCron(expr: string): boolean {
  return parseCronExpression(expr) !== null;
}

export function cronMatchesDate(expr: string, date: Date): boolean {
  const cron = parseCronExpression(expr);
  if (!cron) return false;

  const minuteMatch = matchesCronField(cron.minute, date.getMinutes(), 0, 59);
  const hourMatch = matchesCronField(cron.hour, date.getHours(), 0, 23);
  const monthMatch = matchesCronField(cron.month, date.getMonth() + 1, 1, 12);
  const domMatch = matchesCronField(cron.dayOfMonth, date.getDate(), 1, 31);
  const dowMatch = matchesCronField(cron.dayOfWeek, date.getDay(), 0, 7, true);
  const domAny = cron.dayOfMonth === "*";
  const dowAny = cron.dayOfWeek === "*";
  const dayMatch = domAny || dowAny ? domMatch && dowMatch : domMatch || dowMatch;

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

function parseCronExpression(expr: string): CronExpression | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!validateCronField(minute, 0, 59)) return null;
  if (!validateCronField(hour, 0, 23)) return null;
  if (!validateCronField(dayOfMonth, 1, 31)) return null;
  if (!validateCronField(month, 1, 12)) return null;
  if (!validateCronField(dayOfWeek, 0, 7, true)) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function validateCronField(field: string, min: number, max: number, dayOfWeek = false): boolean {
  const parts = field.split(",");
  if (parts.length === 0) return false;
  return parts.every((part) => parseCronPart(part.trim(), min, max, dayOfWeek) !== null);
}

function matchesCronField(field: string, value: number, min: number, max: number, dayOfWeek = false): boolean {
  const normalizedValue = normalizeCronValue(value, dayOfWeek);
  return field.split(",").some((part) => {
    const parsed = parseCronPart(part.trim(), min, max, dayOfWeek);
    if (!parsed) return false;
    if (parsed.start <= parsed.end) {
      if (normalizedValue < parsed.start || normalizedValue > parsed.end) return false;
      return (normalizedValue - parsed.start) % parsed.step === 0;
    }
    if (normalizedValue >= parsed.start) {
      return (normalizedValue - parsed.start) % parsed.step === 0;
    }
    if (normalizedValue <= parsed.end) {
      return (normalizedValue - parsed.start + max - min + 1) % parsed.step === 0;
    }
    return false;
  });
}

function parseCronPart(part: string, min: number, max: number, dayOfWeek: boolean): ParsedCronPart | null {
  if (!part) return null;

  const pieces = part.split("/");
  if (pieces.length > 2) return null;

  const base = pieces[0];
  const step = pieces[1] ? Number.parseInt(pieces[1], 10) : 1;
  if (!Number.isInteger(step) || step <= 0) return null;

  if (base === "*") {
    return { start: min, end: max, step };
  }

  if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-");
    if (!rawStart || !rawEnd) return null;
    const startRaw = Number.parseInt(rawStart, 10);
    const endRaw = Number.parseInt(rawEnd, 10);
    if (!Number.isInteger(startRaw) || !Number.isInteger(endRaw)) return null;
    if (dayOfWeek) {
      if (startRaw < 0 || startRaw > 7 || endRaw < 0 || endRaw > 7) return null;
      if (startRaw > endRaw) return null;
    } else {
      if (startRaw < min || startRaw > max || endRaw < min || endRaw > max) return null;
      if (startRaw > endRaw) return null;
    }
    return { start: normalizeCronValue(startRaw, dayOfWeek), end: normalizeCronValue(endRaw, dayOfWeek), step };
  }

  const value = parseCronNumber(base, min, max, dayOfWeek);
  if (value === null) return null;
  return { start: value, end: value, step };
}

function parseCronNumber(raw: string, min: number, max: number, dayOfWeek: boolean): number | null {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) return null;
  if (dayOfWeek) {
    if (value < 0 || value > 7) return null;
  } else {
    if (value < min || value > max) return null;
  }
  return normalizeCronValue(value, dayOfWeek);
}

function normalizeCronValue(value: number, dayOfWeek: boolean): number {
  if (dayOfWeek && value === 7) return 0;
  return value;
}

async function resolveScheduleDirectory(directory: string | undefined, cwd: string): Promise<string> {
  const resolved = directory ? path.resolve(cwd, directory) : cwd;
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Schedule directory does not exist: ${resolved}`);
  }
  return resolved;
}

async function listScheduleFiles(): Promise<string[]> {
  await ensureSchedulesDir();
  try {
    const files = await fs.readdir(getSchedulesDirPath());
    return files.filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readScheduleRecord(filePath: string): Promise<StoredSchedule | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredSchedule;
  } catch {
    return null;
  }
}

async function writeScheduleRecord(schedule: StoredSchedule): Promise<void> {
  await ensureSchedulesDir();
  await fs.mkdir(getScheduleLogDir(schedule.id), { recursive: true });
  await fs.writeFile(getScheduleRecordPath(schedule.id), JSON.stringify(schedule, null, 2), "utf8");
}
