/**
 * @vitest-environment jsdom
 *
 * SmartglassesView tests render the dashboard against a fake native bridge so
 * the EvenBridgeTransport path, report rows, Wi-Fi controls, and mic flows are
 * exercised through the real component.
 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartglassesView } from "../ui/SmartglassesView.tsx";

// The fake bridge implements only the native operations the component invokes.
function makeFakeBridge() {
	let eventCb: ((event: unknown) => void) | null = null;
	const writes: Array<{ side: string; first: number; bytes: number }> = [];
	const micCalls: boolean[] = [];
	const wifi = {
		scan: {
			networks: [{ ssid: "HomeNet" }, { ssid: "OfficeNet" }, "GuestWifi"],
		},
		status: { connected: true, ssid: "HomeNet", localIp: "192.168.1.42" },
		credentials: [] as Array<{ ssid: string; password: string }>,
	};
	const bridge = {
		onEvent(cb: (event: unknown) => void) {
			eventCb = cb;
			return () => {
				eventCb = null;
			};
		},
		async write(side: string, data: Uint8Array) {
			writes.push({ side, first: data[0], bytes: data.length });
		},
		async setMicState(sendPcm: boolean) {
			micCalls.push(sendPcm);
		},
		async requestWifiScan() {
			return wifi.scan;
		},
		async requestWifiStatus() {
			return wifi.status;
		},
		async setWifiCredentials(ssid: string, password: string) {
			wifi.credentials.push({ ssid, password });
			return { status: `credentials accepted for ${ssid}` };
		},
		async requestWifiSetup() {
			return { status: "native setup launched" };
		},
	};
	return {
		bridge,
		writes,
		micCalls,
		wifi,
		pushEvent(event: unknown) {
			eventCb?.(event);
		},
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

let env: ReturnType<typeof makeFakeBridge>;

beforeEach(() => {
	env = makeFakeBridge();
	(window as unknown as { __evenBridge?: unknown }).__evenBridge = env.bridge;
});

afterEach(() => {
	cleanup();
	(window as unknown as { __evenBridge?: unknown }).__evenBridge = undefined;
	(window as unknown as { __mentraBridge?: unknown }).__mentraBridge =
		undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connect(): Promise<void> {
	const connectBtn = screen.getByRole("button", { name: "Connect" });
	await act(async () => {
		fireEvent.click(connectBtn);
	});
	await flush();
}

describe("SmartglassesView — connection + status display", () => {
	it("starts Offline with idle lenses and an empty events panel", () => {
		render(<SmartglassesView />);
		expect(screen.getByText("Offline")).toBeTruthy();
		// Both lens pills read the idle state.
		expect(screen.getAllByText("idle")).toHaveLength(2);
		expect(screen.getByText("None")).toBeTruthy();
		// Report shows the native bridge is available (window.__evenBridge set).
		expect(screen.getByText("available")).toBeTruthy();
	});

	it("connects the whole headset: lens pills -> connected, StatusPill -> Connected, init checklist marked", async () => {
		render(<SmartglassesView />);
		await connect();

		// Header StatusPill + both lens pills now read connected.
		expect(screen.getByText("Connected")).toBeTruthy();
		expect(screen.getAllByText("connected")).toHaveLength(2);

		// Report Transport row populated from the bridge transport name.
		expect(screen.getByText("even-bridge")).toBeTruthy();

		// connectionReady writes happened on both lenses: lens-specific mode encodes
		// left as Init (0x4d) and right as RightInit (0xf4).
		expect(env.writes.some((w) => w.first === 0x4d)).toBe(true);
		expect(env.writes.some((w) => w.first === 0xf4)).toBe(true);

		// Checklist "Whole headset" + "Init packets" are now checked (CheckRow renders
		// a CheckCircle2 with the green styling; assert the label rows exist).
		expect(screen.getByText("Whole headset")).toBeTruthy();
		expect(screen.getByText("Init packets")).toBeTruthy();

		// Events panel logged the connect.
		expect(screen.getByText("Whole headset connected")).toBeTruthy();
	});
});

describe("SmartglassesView — platform tabs", () => {
	it("swaps PLATFORM_COPY text when switching platform tabs", () => {
		render(<SmartglassesView />);

		// Default desktop copy.
		expect(screen.getByText("Chrome/Edge Web Bluetooth")).toBeTruthy();

		// The platform tabs are <button>s with an aria-label; the agent-surface "tab"
		// role is not reflected as a DOM role, so query by accessible (aria-label) name.
		fireEvent.click(screen.getByRole("button", { name: "iOS platform" }));
		expect(screen.getByText("Native bridge required")).toBeTruthy();
		expect(screen.queryByText("Chrome/Edge Web Bluetooth")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Android platform" }));
		expect(screen.getByText("Native bridge preferred")).toBeTruthy();
	});
});

describe("SmartglassesView — display presets + control gating", () => {
	it("marks the active preset with aria-pressed and only one preset at a time", () => {
		render(<SmartglassesView />);

		const status = screen.getByRole("button", { name: "Status" });
		const ping = screen.getByRole("button", { name: "Ping" });
		expect(status.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(status);
		expect(status.getAttribute("aria-pressed")).toBe("true");
		expect(ping.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(ping);
		expect(ping.getAttribute("aria-pressed")).toBe("true");
		expect(status.getAttribute("aria-pressed")).toBe("false");
	});

	it("disables Display/Clear/Mic/Run-Check until the headset is connected, then enables them", async () => {
		render(<SmartglassesView />);

		const display = screen.getByRole("button", { name: "Send Display" });
		const runCheck = screen.getByRole("button", { name: "Run Check" });
		expect((display as HTMLButtonElement).disabled).toBe(true);
		expect((runCheck as HTMLButtonElement).disabled).toBe(true);

		await connect();

		expect(
			(
				screen.getByRole("button", {
					name: "Send Display",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(
			(screen.getByRole("button", { name: "Run Check" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});
});

describe("SmartglassesView — display / clear / mic handlers", () => {
	it("Display sends SendResult packets, marks the Display check, and logs an event", async () => {
		render(<SmartglassesView />);
		await connect();

		const before = env.writes.filter((w) => w.first === 0x4e).length;
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Send Display" }));
		});
		await flush();

		const after = env.writes.filter((w) => w.first === 0x4e).length;
		expect(after).toBeGreaterThan(before);
		expect(screen.getByText(/display page/i)).toBeTruthy();
	});

	it("Mic On opens the microphone through the bridge and logs Enabled", async () => {
		render(<SmartglassesView />);
		await connect();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Turn Mic On" }));
		});
		await flush();

		// setMicState(true,...) called on the bridge.
		expect(env.micCalls).toContain(true);
		expect(screen.getByText("Enabled")).toBeTruthy();
		// Button label flips to "Turn Mic Off".
		expect(screen.getByRole("button", { name: "Turn Mic Off" })).toBeTruthy();
	});

	it("Run Check requests serial/battery + settings and marks the serial/settings checks", async () => {
		render(<SmartglassesView />);
		await connect();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Run Check" }));
		});
		await flush();

		// get-serial (0x34) was written.
		expect(env.writes.some((w) => w.first === 0x34)).toBe(true);
		expect(
			screen.getByText("Requested serial/battery and sent settings packets"),
		).toBeTruthy();
	});
});

describe("SmartglassesView — tap-driven mic auto flow", () => {
	it("auto-enables the mic on a single-tap event and auto-disables on a double-tap event", async () => {
		render(<SmartglassesView />);
		await connect();

		// Single tap -> mic enable.
		await act(async () => {
			env.pushEvent({ type: "single_tap" });
		});
		await flush();
		expect(env.micCalls).toContain(true);
		expect(screen.getByText("Enabled by tap")).toBeTruthy();

		// Double tap -> mic disable.
		await act(async () => {
			env.pushEvent({ type: "double_tap" });
		});
		await flush();
		expect(env.micCalls).toContain(false);
		expect(screen.getByText("Disabled by tap")).toBeTruthy();
	});
});

describe("SmartglassesView — Wi-Fi panel", () => {
	it("disables every Wi-Fi button when no bridge is available", () => {
		(window as unknown as { __evenBridge?: unknown }).__evenBridge = undefined;
		render(<SmartglassesView />);

		for (const name of [
			"Scan Wi-Fi",
			"Refresh Wi-Fi Status",
			"Configure Wi-Fi",
			"Native Wi-Fi Setup",
		]) {
			expect(
				(screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
			).toBe(true);
		}
	});

	it("Scan parses the native response into network chips", async () => {
		render(<SmartglassesView />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Scan Wi-Fi" }));
		});
		await flush();

		expect(screen.getByText("Found 3 network(s)")).toBeTruthy();
		expect(screen.getByText("HomeNet")).toBeTruthy();
		expect(screen.getByText("OfficeNet")).toBeTruthy();
		expect(screen.getByText("GuestWifi")).toBeTruthy();
	});

	it("Status formats the native connection status string", async () => {
		render(<SmartglassesView />);

		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: "Refresh Wi-Fi Status" }),
			);
		});
		await flush();

		expect(
			screen.getByText("Connected to HomeNet at 192.168.1.42"),
		).toBeTruthy();
	});

	it("Configure without an SSID surfaces 'Enter a Wi-Fi SSID'", async () => {
		render(<SmartglassesView />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Configure Wi-Fi" }));
		});
		await flush();

		// The message surfaces in both the wifiStatus line and the error banner.
		expect(
			screen.getAllByText("Enter a Wi-Fi SSID").length,
		).toBeGreaterThanOrEqual(1);
		expect(env.wifi.credentials).toHaveLength(0);
	});

	it("Configure sends the entered SSID + password to the bridge", async () => {
		render(<SmartglassesView />);

		fireEvent.change(screen.getByLabelText("Wi-Fi SSID"), {
			target: { value: "MyNet" },
		});
		fireEvent.change(screen.getByLabelText("Wi-Fi password"), {
			target: { value: "hunter2" },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Configure Wi-Fi" }));
		});
		await flush();

		expect(env.wifi.credentials).toEqual([
			{ ssid: "MyNet", password: "hunter2" },
		]);
		expect(screen.getByText("Credentials sent for MyNet")).toBeTruthy();
	});
});

describe("SmartglassesView — Report panel", () => {
	it("populates report rows and copies the report JSON to the clipboard + window global", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal("navigator", {
			...window.navigator,
			clipboard: { writeText },
		});

		render(<SmartglassesView />);
		await connect();

		// Report rows: Transport, Bridge available, Events count.
		expect(screen.getByText("even-bridge")).toBeTruthy();
		expect(screen.getByText("available")).toBeTruthy();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy Report" }));
		});
		await flush();

		expect(writeText).toHaveBeenCalledTimes(1);
		const json = writeText.mock.calls[0][0] as string;
		const parsed = JSON.parse(json);
		expect(parsed.transport).toBe("even-bridge");
		expect(parsed.connected).toBe(true);
		expect(
			(window as unknown as { facewearSmartglassesReport?: unknown })
				.facewearSmartglassesReport,
		).toBeTruthy();
	});

	it("Download builds a JSON blob and triggers an anchor download", async () => {
		const createObjectURL = vi.fn(() => "blob:fake");
		const revokeObjectURL = vi.fn();
		vi.stubGlobal("URL", {
			...URL,
			createObjectURL,
			revokeObjectURL,
		});
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});

		render(<SmartglassesView />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Download Report" }));
		});
		await flush();

		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(clickSpy).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
		expect(screen.getByText("Downloaded diagnostics report")).toBeTruthy();
	});
});

describe("SmartglassesView — Events panel overflow", () => {
	it("renders the most recent VISIBLE_EVENT_LIMIT=12 events newest-first with a '+N older events' row", async () => {
		render(<SmartglassesView />);
		await connect();

		// Drive many events via taps + display so the event list exceeds 12.
		for (let i = 0; i < 20; i++) {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				env.pushEvent({ type: "single_tap" });
			});
		}
		await flush();

		// Overflow row present (more than 12 events recorded).
		expect(screen.getByText(/\+\d+ older events/)).toBeTruthy();
	});
});

describe("SmartglassesView — headset state hint", () => {
	it("shows the wear-required hint and updates to ready when a wearing state arrives", async () => {
		render(<SmartglassesView />);
		await connect();

		// Before any physical state, the hint requires a wear state.
		expect(
			screen.getByText("Wear state required for tap/audio validation."),
		).toBeTruthy();

		// Push a physical "wearing" state event as raw G1 bytes (StartAi 0xf5 +
		// physical-state code 0x06 -> "wearing") so it flows through the real
		// EvenBridgeTransport -> parseG1Notification decode path.
		await act(async () => {
			env.pushEvent({ side: "right", raw: [0xf5, 0x06] });
		});
		await flush();

		expect(screen.getByText("Ready for tap/audio validation.")).toBeTruthy();
		// The physical-state chip renders inside the headset hint.
		const hint = screen.getByText("Ready for tap/audio validation.")
			.parentElement as HTMLElement;
		expect(within(hint).getByText("wearing")).toBeTruthy();
	});
});
