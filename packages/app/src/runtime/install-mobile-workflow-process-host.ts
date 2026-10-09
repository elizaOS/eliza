/** Native bootstrap only: environment is supplied by the app service, never a route or workflow. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { formatCalendarEventDateTime } from "@elizaos/plugin-calendar/format";
import { requestBionicHost } from "@elizaos/plugin-native-inference/bionic-host-request";
import { configureHostedNativeSourceReader } from "@elizaos/plugin-workflow/services/hosted-native-source";
import {
  configureWorkflowProcessHost,
  WORKFLOW_BUN_FLAGS,
} from "@elizaos/plugin-workflow/services/workflow-process-host";

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function directory(value: string | undefined): string {
  requireValue(
    value &&
      isAbsolute(value) &&
      realpathSync(value) === value &&
      lstatSync(value).isDirectory(),
    "Mobile workflow resource directory unavailable",
  );
  return value;
}
function pin(value: string | undefined) {
  requireValue(
    value &&
      isAbsolute(value) &&
      realpathSync(value) === value &&
      lstatSync(value).isFile(),
    "Mobile workflow executable unavailable",
  );
  return {
    path: value,
    sha256: createHash("sha256").update(readFileSync(value)).digest("hex"),
  };
}
export function installMobileWorkflowProcessHost(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.ELIZA_PLATFORM !== "android" &&
    env.ELIZA_MOBILE_PLATFORM !== "android"
  )
    return;
  if (env.ELIZA_MOBILE_WORKFLOWS !== "1") return;
  const root = directory(env.ELIZA_SMTHRS_RUNTIME_DIR);
  const manifestPath = join(root, "manifest.json");
  requireValue(
    lstatSync(manifestPath).size <= 1024 * 1024,
    "Worker manifest too large",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  requireValue(
    manifest.version === 1 &&
      manifest.compiler?.version === 1 &&
      manifest.compiler.compilerModule ===
        "node_modules/typescript/lib/typescript.js",
    "Unsupported worker compiler manifest",
  );
  requireValue(
    manifest.files &&
      typeof manifest.files === "object" &&
      !Array.isArray(manifest.files),
    "Invalid worker file index",
  );
  const entries = Object.entries(manifest.files);
  requireValue(
    entries.length > 0 && entries.length <= 4096,
    "Invalid worker file count",
  );
  const indexPath = join(root, "files.sha256");
  requireValue(
    lstatSync(indexPath).isFile() &&
      lstatSync(indexPath).size <= 1024 * 1024 &&
      realpathSync(indexPath) === indexPath,
    "Worker extraction index unavailable",
  );
  const index = new Map<string, string>();
  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    requireValue(
      parts.length === 2 &&
        /^[a-f0-9]{64}$/.test(parts[0]) &&
        !index.has(parts[1]),
      "Invalid worker extraction index",
    );
    index.set(parts[1], parts[0]);
  }
  requireValue(
    index.size === entries.length + 1 &&
      index.get("manifest.json") === pin(manifestPath).sha256,
    "Worker manifest not bound to extraction index",
  );
  let total = 0;
  const expected = new Set<string>(["manifest.json", "files.sha256"]);
  for (const [name, digest] of entries) {
    requireValue(
      name &&
        !isAbsolute(name) &&
        !name
          .split("/")
          .some((part) => !part || part === "." || part === "..") &&
        !name.includes("\\") &&
        typeof digest === "string" &&
        /^[a-f0-9]{64}$/.test(digest),
      "Invalid worker file entry",
    );
    const file = join(root, name),
      info = lstatSync(file);
    requireValue(
      info.isFile() && !info.isSymbolicLink() && realpathSync(file) === file,
      "Worker file escaped immutable artifact",
    );
    total += info.size;
    requireValue(total <= 64 * 1024 * 1024, "Worker artifact too large");
    requireValue(
      index.get(name) === digest && pin(file).sha256 === digest,
      "Worker resource hash mismatch",
    );
    expected.add(name);
  }
  function verifyTree(dir: string): void {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name),
        info = lstatSync(file);
      if (info.isDirectory() && !info.isSymbolicLink()) verifyTree(file);
      else
        requireValue(
          info.isFile() &&
            !info.isSymbolicLink() &&
            expected.has(relative(root, file)),
          "Unindexed worker resource",
        );
    }
  }
  verifyTree(root);
  const state = directory(env.ELIZA_STATE_DIR),
    stateRoot = join(state, "smthrs");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  directory(stateRoot);
  const compilerRoot = directory(join(root, "compiler"));
  const libraries = env.LD_LIBRARY_PATH?.split(":");
  requireValue(libraries?.length, "Native library directories unavailable");
  const bunFlags: Partial<
    Record<(typeof WORKFLOW_BUN_FLAGS)[number], boolean>
  > = {};
  for (const key of WORKFLOW_BUN_FLAGS)
    if (env[key] !== undefined) {
      requireValue(
        env[key] === "0" || env[key] === "1",
        "Invalid mobile Bun compatibility flag",
      );
      bunFlags[key] = env[key] === "1";
    }
  const launcher = {
    executable: pin(env.LD_PATH),
    prefixFiles: [pin(env.BUN_PATH)],
  };
  const nativeSocket = env.ELIZA_BIONIC_INFERENCE_SOCK;
  if (env.ELIZA_BIONIC_HOST_DELEGATED === "1" && nativeSocket) {
    configureHostedNativeSourceReader(async (request) => {
      const response = await requestBionicHost(
        nativeSocket,
        { op: "nativeSourceRead", request },
        30_000,
      );
      if (
        !response ||
        typeof response !== "object" ||
        !("ok" in response) ||
        response.ok !== true ||
        !("result" in response)
      )
        throw new Error("Native selected source is unavailable");
      if (request.action !== "read") return response.result;
      const snapshot = response.result as {
        timeZone: string;
        observedAt: string;
        events: Array<{ start: string; end: string; allDay: boolean }>;
        reminders: Array<{ dueAt: string }>;
      };
      const local = (startAt: string, isAllDay = false) =>
        formatCalendarEventDateTime(
          { startAt, timezone: snapshot.timeZone, isAllDay },
          {
            includeYear: true,
            includeTimeZoneName: true,
            timeZone: snapshot.timeZone,
          },
        );
      return {
        ...snapshot,
        asOfDisplay: local(snapshot.observedAt),
        events: snapshot.events.map((event) => ({
          ...event,
          startDisplay: local(event.start, event.allDay),
          ...(event.allDay
            ? {
                endDateExclusive: event.end.slice(0, 10),
                lastDateDisplay: local(
                  new Date(
                    new Date(event.end).getTime() - 86400000,
                  ).toISOString(),
                  true,
                ),
              }
            : { endDisplay: local(event.end) }),
        })),
        reminders: snapshot.reminders.map((reminder) => ({
          ...reminder,
          dueAtDisplay: local(reminder.dueAt),
        })),
      };
    });
  }
  configureWorkflowProcessHost({
    runtime: launcher,
    compiler: launcher,
    compilerRuntime: "bun",
    dependencyRoot: root,
    compilerDependencyRoot: compilerRoot,
    compilerModule: pin(join(compilerRoot, manifest.compiler.compilerModule)),
    libraryDirectories: libraries.map(directory),
    stateRoot,
    bunFlags,
  });
}
