/**
 * Android counterpart to the iOS stdio bridge — the native-side of the
 * port-free local-agent transport (#12352, #12180 phase 2).
 *
 * On Android the elizaOS agent runs as a DETACHED Bun child process managed by
 * `ElizaAgentService` (launch.sh setsid double-fork, so it outlives the service
 * and survives app-swipe). This module boots that runtime with `localAgentMode`
 * so it binds NO TCP listener (unless `ELIZA_API_EXPOSE_PORT` re-opens it for
 * dev/LAN/e2e), then serves the WebView over an abstract-namespace AF_UNIX
 * socket — the same in-process `dispatchRoute` kernel the HTTP server used, with
 * no loopback hop. True stdin/stdout piping is impossible here: the detach
 * severs the parent pipe, and the priv_app SELinux domain denies pipe ioctl. The
 * abstract UDS is the sanctioned Android IPC (the bionic inference host uses the
 * same). `ElizaAgentService.requestLocalAgent` / `requestLocalAgentStream`
 * connect to this socket per call; the WebView `Agent.request` / `requestStream`
 * Capacitor contract is unchanged.
 *
 * Frame protocol (shared kernel `createStdioBridge`), one connection per call:
 *   in:  {"id","method":"http_request"|"http_request_stream","stream?":true,"payload":{path,method,headers,body}}
 *   out (buffered):  {"id","ok":true,"result":{status,statusText,headers,body,bodyBase64,bodyEncoding}}
 *   out (streaming): {"id","stream":"response",status,statusText,headers}
 *                    {"id","stream":"chunk","dataBase64"}
 *                    {"id","stream":"complete"[,"error"]}
 * All logging goes to the file logger (stdout is /dev/null on the detached
 * process); the socket carries only protocol frames.
 *
 * This module is imported by the agent bundle's `android-bridge` CLI command:
 *   `bun agent-bundle.js android-bridge`
 *
 * Environment defaults set here mirror `ElizaAgentService` and use `||=` so the
 * service's values (state dir, tokens) win. The service sets richer values
 * before spawning the bundle; this module only fills gaps for direct runs.
 */

import {
	createServer as createNetServer,
	type Server as NodeServer,
	type Socket as NodeSocket,
} from "node:net";
import process from "node:process";

// ── Step 1: set Android env vars before any elizaOS module import ──────────

// These match what ElizaAgentService passes as process.env; keep in sync.
process.env.ELIZA_PLATFORM ||= "android";
process.env.ELIZA_MOBILE_PLATFORM ||= "android";
process.env.ELIZA_ANDROID_LOCAL_BACKEND ||= "1";
process.env.ELIZA_DISABLE_DIRECT_RUN ||= "1";
process.env.ELIZA_HEADLESS ||= "1";
process.env.ELIZA_VAULT_BACKEND ||= "file";
process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER ||= "1";
process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP ||= "1";
process.env.LOG_LEVEL ||= "error";

// Disable on-device optimisation pipeline (no prompt training on mobile).
process.env.ELIZA_DISABLE_AUTO_BOOTSTRAP ||= "1";
process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING ||= "1";

// ── Step 2: install the mobile fs sandbox shim ────────────────────────────
// Use ELIZA_STATE_DIR (set by ElizaAgentService) as the workspace root.
// Fall back to HOME/.eliza if running standalone outside the service.

import * as nodeFs from "node:fs";
import nodePath from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { androidAliasSibling, installMobileFsShim } from "../shared/fs-shim.ts";
import {
	createStdioBridge,
	type StdioBridgeResponseFrame,
} from "../shared/stdio-bridge.ts";
import {
	type AndroidCoreRouteDeps,
	type AndroidDispatchRoute,
	type AndroidRequestPayload,
	dispatchBufferedRequest,
	dispatchStreamingRequest,
} from "./dispatch.ts";

type StartEliza = (options: {
	serverOnly: true;
	localAgentMode: true;
}) => Promise<IAgentRuntime | undefined>;

interface AndroidAgentModule {
	startEliza: StartEliza;
	dispatchRoute: AndroidDispatchRoute;
	/** Persisted-config seams for the server-level core routes (first-run). */
	coreRoutes: AndroidCoreRouteDeps;
}

async function loadAgentModule(): Promise<AndroidAgentModule> {
	// Literal specifier with @vite-ignore: Vite skips it (so the WebView build's
	// import-analysis boundary gate doesn't try to pull @elizaos/agent into the
	// renderer bundle), while Bun.build — which ignores @vite-ignore — sees the
	// literal and inlines @elizaos/agent via the mobile dedupe plugin. The prior
	// `"@elizaos/" + "agent"` concatenation hid the specifier from Bun too, so it
	// externalized the import and the on-device agent crashed at startup with
	// `Cannot find module '@elizaos/agent'` (no node_modules on device).
	const mod = (await import(/* @vite-ignore */ "@elizaos/agent")) as {
		startEliza: StartEliza;
		dispatchRoute: AndroidDispatchRoute;
		configFileExists: AndroidCoreRouteDeps["configFileExists"];
		loadElizaConfig: AndroidCoreRouteDeps["loadElizaConfig"];
		saveElizaConfig: AndroidCoreRouteDeps["saveElizaConfig"];
		hasPersistedFirstRunState: AndroidCoreRouteDeps["hasPersistedFirstRunState"];
	};
	return {
		startEliza: mod.startEliza,
		dispatchRoute: mod.dispatchRoute,
		coreRoutes: {
			configFileExists: mod.configFileExists,
			loadElizaConfig: mod.loadElizaConfig,
			saveElizaConfig: mod.saveElizaConfig,
			hasPersistedFirstRunState: mod.hasPersistedFirstRunState,
		},
	};
}

// ── Resolve canonical paths and install mobile fs sandbox ─────────────────
//
// On Android, getFilesDir() returns /data/user/0/<pkg>/files but the bundle
// runs from /data/data/<pkg>/files (the real path; /data/user/0 is a symlink).
// The mobile-fs-shim uses string-prefix matching, so the sandbox root and all
// fs paths passed to it must use the same canonical form.
//
// Strategy:
//   1. Resolve HOME (= getFilesDir) through realpathSync → canonical root.
//   2. Update ELIZA_STATE_DIR / ELIZA_STATE_DIR / HOME to use the canonical
//      prefix so any downstream path construction produces matching strings.
//   3. Set sandbox root = canonical HOME → covers .eliza/, agent/ assets, etc.
let _logPath = "";

function setupAndroidBridgeEnvironment(): string {
	const rawHome =
		process.env.HOME ||
		nodePath.dirname(
			process.env.ELIZA_STATE_DIR ||
				process.env.ELIZA_STATE_DIR ||
				"/data/local/tmp/.eliza",
		);

	let canonicalHome: string;
	try {
		canonicalHome = nodeFs.realpathSync(rawHome);
	} catch {
		canonicalHome = rawHome;
	}

	// Remap any env var carrying a non-canonical spelling of the home dir to
	// the canonical prefix so downstream path construction produces matching
	// strings. Two sources of drift, remapped independently: the raw HOME the
	// process was launched with (when it was itself a symlink spelling), and
	// the Android /data/data ↔ /data/user/0 alias of the canonical home —
	// which can appear in OTHER env vars (ELIZA_STATE_DIR, TMPDIR, …) even
	// when HOME arrived already canonical, so gating all remaps on
	// `canonicalHome !== rawHome` missed it and the fs shim rejected every
	// state-dir path at startEliza (silent on-device boot death).
	const stalePrefixes = new Set<string>();
	if (canonicalHome !== rawHome) stalePrefixes.add(rawHome);
	const aliasOfCanonical = androidAliasSibling(canonicalHome);
	if (aliasOfCanonical) stalePrefixes.add(aliasOfCanonical);
	stalePrefixes.delete(canonicalHome);
	if (stalePrefixes.size > 0) {
		if (process.env.HOME && process.env.HOME !== canonicalHome) {
			for (const prefix of stalePrefixes) {
				if (
					process.env.HOME === prefix ||
					process.env.HOME.startsWith(`${prefix}/`)
				) {
					process.env.HOME =
						canonicalHome + process.env.HOME.slice(prefix.length);
					break;
				}
			}
		}
		for (const key of [
			"ELIZA_STATE_DIR",
			"ELIZA_WORKSPACE_DIR",
			"TMPDIR",
			"LOG_FILE",
			"DIAGNOSTICS_FILE",
		] as const) {
			const val = process.env[key];
			if (!val) continue;
			for (const prefix of stalePrefixes) {
				if (val === prefix || val.startsWith(`${prefix}/`)) {
					process.env[key] = canonicalHome + val.slice(prefix.length);
					break;
				}
			}
		}
	}

	const stateDir =
		process.env.ELIZA_STATE_DIR ||
		process.env.ELIZA_STATE_DIR ||
		`${canonicalHome}/.eliza`;

	installMobileFsShim(canonicalHome);

	// Debug file logger (bypasses stdio to avoid TIOCGWINSZ/SELinux issues).
	// Writes to $ELIZA_STATE_DIR/android-bridge.log so we can read via adb run-as.
	_logPath = `${stateDir}/android-bridge.log`;
	try {
		nodeFs.mkdirSync(stateDir, { recursive: true });
	} catch {
		/* ignore */
	}
	_logToFile(`[android-bridge] process started, stateDir=${stateDir}`);
	return stateDir;
}

function _logToFile(line: string): void {
	if (!_logPath) return;
	try {
		nodeFs.appendFileSync(_logPath, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* ignore */
	}
}

// ── Step 3: abstract-namespace AF_UNIX request server ──────────────────────
//
// The bun agent runs DETACHED (launch.sh setsid double-fork, stdin from
// /dev/null, stdout to a log file) so it survives the service that spawned it —
// which severs any stdin/stdout pipe to the parent. And on the priv_app SELinux
// domain a Java ProcessBuilder PIPE (fifo_file) is denied ioctl and kills bun on
// stdio init. So the "stdio" transport is realized as an abstract-namespace
// AF_UNIX socket — the same IPC the bionic inference host already uses under
// priv_app ("no filesystem path, avoids SELinux file-label issues"). The bun
// agent BINDS the socket; ElizaAgentService connects as a client per request.
//
// The socket name (no leading NUL — the connectors add it) is
// ELIZA_LOCAL_AGENT_SOCKET, defaulting to a stable per-app name. Each accepted
// connection gets its own NDJSON kernel over the socket byte stream; the WebView
// contract (buffered result / agentStream* frames) is served by the same shared
// createStdioBridge used on iOS.

const DEFAULT_LOCAL_AGENT_SOCKET = "eliza_local_agent_v1";

function localAgentSocketName(): string {
	const name = process.env.ELIZA_LOCAL_AGENT_SOCKET?.trim();
	return name && name.length > 0 ? name : DEFAULT_LOCAL_AGENT_SOCKET;
}

/** Serve one accepted connection: NDJSON frames in, response frames out. */
function serveConnection(
	socket: NodeSocket,
	runtime: IAgentRuntime,
	dispatchRoute: AndroidDispatchRoute,
	coreRoutes: AndroidCoreRouteDeps,
): void {
	const bridge = createStdioBridge({
		request: async (frame) =>
			dispatchBufferedRequest(
				runtime,
				dispatchRoute,
				(frame.payload ?? {}) as AndroidRequestPayload,
				coreRoutes,
			),
		requestStream: async (frame, sink) =>
			dispatchStreamingRequest(
				runtime,
				dispatchRoute,
				(frame.payload ?? {}) as AndroidRequestPayload,
				sink,
				coreRoutes,
			),
		writeFrame: (frame: StdioBridgeResponseFrame) => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
		},
	});

	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			void bridge.handleLine(line);
		}
	});
	socket.once("end", () => {
		if (buffered.trim()) {
			const line = buffered;
			buffered = "";
			void bridge.handleLine(line);
		}
		void bridge.drain().finally(() => {
			if (!socket.destroyed) socket.end();
		});
	});
	socket.once("error", (err: Error) => {
		_logToFile(`[android-bridge] connection error: ${err.message}`);
	});
}

/** Bind the abstract-namespace request server. Rejects if the name is taken. */
function startLocalAgentServer(
	runtime: IAgentRuntime,
	dispatchRoute: AndroidDispatchRoute,
	coreRoutes: AndroidCoreRouteDeps,
): Promise<NodeServer> {
	const name = localAgentSocketName();
	// Abstract namespace: a leading NUL byte in the path (Linux). Mirrors
	// BionicHostLoader's `net.connect({ path: "\0" + name })`.
	const abstractPath = `\0${name}`;
	const server = createNetServer((socket) => {
		serveConnection(socket, runtime, dispatchRoute, coreRoutes);
	});
	return new Promise<NodeServer>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ path: abstractPath }, () => {
			server.removeListener("error", reject);
			_logToFile(`[android-bridge] listening on abstract UDS "${name}"`);
			resolve(server);
		});
	});
}

// ── Step 4: boot the runtime + serve over the abstract UDS ─────────────────

export async function runAndroidBridgeCli(): Promise<void> {
	setupAndroidBridgeEnvironment();

	// Log the process exit code for every exit (including process.exit(N) calls
	// from deep inside the runtime that bypass our try/catch).
	process.on("exit", (code) => {
		_logToFile(`[android-bridge] process.exit code=${code}`);
	});

	// Intercept console.error so errors logged by the runtime (e.g. the
	// "Could not start API server" message from eliza.ts) are captured in the
	// file log even though stdout/stderr are redirected to /dev/null on Android.
	const _origConsoleError = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		_logToFile(`[console.error] ${args.map(String).join(" ")}`);
		_origConsoleError(...args);
	};
	const _origConsoleWarn = console.warn.bind(console);
	console.warn = (...args: unknown[]) => {
		const msg = args.map(String).join(" ");
		if (
			msg.includes("Error") ||
			msg.includes("error") ||
			msg.includes("fail")
		) {
			_logToFile(`[console.warn] ${msg}`);
		}
		_origConsoleWarn(...args);
	};

	// Fatal breadcrumbs land in the SAME restart-diagnostics JSONL the
	// launcher and ElizaAgentService write/read (launch.sh's shape), so a
	// death inside the detached agent is attributable from the Java side —
	// without this, a fatal here is visible only in android-bridge.log, a
	// file the service never reads, and the user sees a generic "transport
	// hung" card (#13475).
	const _appendDiagnostics = (
		event: string,
		details: Record<string, string>,
	) => {
		try {
			const file =
				process.env.DIAGNOSTICS_FILE ||
				`${process.cwd()}/agent-restart-diagnostics.jsonl`;
			const record = {
				ts: Date.now(),
				event,
				status: "agent-child",
				detachedAgentMode: true,
				restartAttempts: -1,
				details: {
					...details,
					pid: String(process.pid),
					startupTraceId: process.env.ELIZA_STARTUP_TRACE_ID ?? "",
				},
			};
			nodeFs.appendFileSync(file, `${JSON.stringify(record)}\n`);
		} catch {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — the breadcrumb
			// writer can never take down the agent it is documenting; the fatal
			// is still mirrored to android-bridge.log below.
		}
	};

	process.on("unhandledRejection", (reason) => {
		const msg =
			reason instanceof Error ? reason.stack || reason.message : String(reason);
		_logToFile(`[android-bridge] unhandledRejection: ${msg}`);
		_appendDiagnostics("agent-fatal", {
			kind: "unhandledRejection",
			message: msg.slice(0, 2000),
		});
		console.error("[android-bridge] unhandled rejection:", msg);
	});
	process.on("uncaughtException", (error) => {
		_logToFile(
			`[android-bridge] uncaughtException: ${error.stack || error.message}`,
		);
		_appendDiagnostics("agent-fatal", {
			kind: "uncaughtException",
			message: (error.stack || error.message).slice(0, 2000),
		});
		console.error(
			"[android-bridge] uncaught exception:",
			error.stack || error.message,
		);
		// Installing this handler suppresses the runtime's default fatal exit;
		// without an explicit exit a post-boot uncaught exception leaves a
		// zombie agent the supervisor never learns about. Exit loudly instead.
		process.exit(1);
	});

	// Mid-boot SIGTERM/SIGINT window: the graceful stop handlers register only
	// AFTER startEliza returns, so the entire multi-second boot was previously
	// a silent-kill window (a service stop/restart pkill landed with zero
	// breadcrumbs). These early handlers attribute the death, then exit with
	// the conventional 128+signal code; the post-boot graceful registration
	// below replaces them.
	const _earlySignalExit = (signal: "SIGTERM" | "SIGINT") => {
		_logToFile(`[android-bridge] ${signal} during boot — exiting`);
		_appendDiagnostics("agent-terminated-by-signal", {
			kind: signal,
			stage: "boot",
		});
		process.exit(signal === "SIGTERM" ? 143 : 130);
	};
	const _earlyTerm = () => _earlySignalExit("SIGTERM");
	const _earlyInt = () => _earlySignalExit("SIGINT");
	process.once("SIGTERM", _earlyTerm);
	process.once("SIGINT", _earlyInt);

	_logToFile("[android-bridge] importing agent module...");
	const { startEliza, dispatchRoute, coreRoutes } = await loadAgentModule();
	_logToFile(
		"[android-bridge] calling startEliza({ serverOnly: true, localAgentMode: true })...",
	);

	// Heartbeat: log every 10s during startEliza so we can see where it stalls.
	const _hb = setInterval(() => {
		_logToFile("[android-bridge] startEliza still running...");
	}, 10_000);

	let runtime: IAgentRuntime | undefined;
	try {
		// localAgentMode: no TCP listener binds (the WebView reaches us over the
		// stdio pipe below). ELIZA_API_EXPOSE_PORT re-opens the port for dev/e2e.
		runtime = await startEliza({ serverOnly: true, localAgentMode: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.stack || err.message : String(err);
		_logToFile(`[android-bridge] startEliza THREW: ${msg}`);
		_appendDiagnostics("agent-fatal", {
			kind: "startEliza-threw",
			message: msg.slice(0, 2000),
		});
		throw err;
	} finally {
		clearInterval(_hb);
	}

	_logToFile(
		`[android-bridge] startEliza returned: runtime=${runtime ? "present" : "null"}, ` +
			`ELIZA_ANDROID_LOCAL_BACKEND=${process.env.ELIZA_ANDROID_LOCAL_BACKEND ?? "(unset)"}`,
	);

	if (!runtime) {
		throw new Error(
			"[android-bridge] startEliza returned no runtime; cannot serve stdio requests",
		);
	}

	// ── Step 4: wire inference delegation if device-bridge enabled ────────────
	// Registers TEXT_SMALL/TEXT_LARGE/TEXT_EMBEDDING handlers (registerModel) on
	// the runtime. When ELIZA_BIONIC_HOST_DELEGATED=1 (dynamic-Vulkan fused lib
	// staged), the TEXT generate handler routes to the in-process bionic GPU
	// host over an abstract UDS instead of the device-bridge WebSocket — see
	// makeGenerateHandler in mobile-device-bridge-bootstrap.
	if (runtime && process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1") {
		_logToFile("[android-bridge] importing mobile-device-bridge-bootstrap…");
		const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
			"../mobile-device-bridge-bootstrap.ts"
		);
		await ensureMobileDeviceBridgeInferenceHandlers(runtime as never);

		// Install the cross-provider prefer-local router. Without it, cloud
		// providers (plugin-elizacloud registers at priority 50) win over the
		// local handlers (priority 0) and the chat 401s on a fresh local install
		// ("stuck-cloud"). ensureLocalInferenceHandler installs this on desktop,
		// but that boot path does not run on mobile — so do it here. The router
		// sits at MAX_SAFE_INTEGER, dispatches first, and picks a real provider
		// per the routing policy (default prefer-local), recognising
		// capacitor-llama as a local provider.
		try {
			const { installRouterHandler } = (await import(
				"@elizaos/plugin-local-inference/runtime"
			)) as { installRouterHandler: (rt: unknown, opts: unknown) => void };
			installRouterHandler(runtime, {});
			_logToFile(
				"[android-bridge] installed prefer-local cross-provider router",
			);
		} catch (err) {
			_logToFile(
				`[android-bridge] router install failed (local routing may defer to priority): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	// ── Serve WebView requests over the abstract UDS ──────────────────────────
	// The runtime is up with the in-process route kernel wired but no TCP
	// listener; ElizaAgentService connects per request/stream and drives
	// dispatchRoute over the socket until the user stops the service (SIGTERM /
	// app swiped away).
	let stop: (() => void) | null = null;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	// Boot is over: retire the attribute-and-exit boot handlers in favor of
	// the graceful server stop.
	process.removeListener("SIGTERM", _earlyTerm);
	process.removeListener("SIGINT", _earlyInt);
	process.once("SIGINT", () => stop?.());
	process.once("SIGTERM", () => stop?.());

	let server: NodeServer;
	try {
		server = await startLocalAgentServer(runtime, dispatchRoute, coreRoutes);
	} catch (err) {
		_logToFile(
			`[android-bridge] failed to bind local-agent socket: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		throw err;
	}
	_logToFile("[android-bridge] local-agent request server ready");

	await stopped;
	server.close();
	_logToFile("[android-bridge] shutdown signal received, exiting.");
}
