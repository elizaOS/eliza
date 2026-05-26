// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstRunShell, type FirstRunShellProps } from "../FirstRunShell";

function props(
	overrides: Partial<FirstRunShellProps> = {},
): FirstRunShellProps {
	return {
		step: "owner",
		draft: {
			ownerName: "",
			agentName: "",
			runtime: "local",
			remoteApiBase: "",
			remoteToken: "",
			useLocalEmbeddings: true,
		},
		elizaCloudConnected: false,
		submitting: false,
		busyText: null,
		error: null,
		cloudError: null,
		voice: {
			supported: true,
			listening: false,
			speaking: false,
			transcript: "",
			error: null,
		},
		primaryLabel: "Continue",
		canBack: false,
		updateDraft: vi.fn(),
		setStep: vi.fn(),
		goNext: vi.fn(),
		goBack: vi.fn(),
		finishRuntime: vi.fn(),
		toggleVoice: vi.fn(async () => {}),
		onPromptReady: vi.fn(),
		...overrides,
	};
}

async function revealPrompt(): Promise<void> {
	await act(async () => {
		vi.runAllTimers();
	});
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("FirstRunShell", () => {
	it("uses a text listening toggle instead of a mic button", async () => {
		vi.useFakeTimers();
		const toggleVoice = vi.fn(async () => {});
		render(<FirstRunShell {...props({ toggleVoice })} />);

		await revealPrompt();

		const voiceToggle = screen.getByRole("button", {
			name: "Start voice input",
		});
		expect(voiceToggle.textContent).toBe("Not listening");
		expect(voiceToggle.querySelector("svg")).toBeNull();
		expect(voiceToggle.className).toContain("bg-transparent");
		expect(voiceToggle.className).toContain("[text-shadow:");

		fireEvent.click(voiceToggle);

		expect(toggleVoice).toHaveBeenCalledTimes(1);
	});

	it("changes the text toggle to listening when voice capture is active", async () => {
		vi.useFakeTimers();
		render(
			<FirstRunShell
				{...props({
					voice: {
						supported: true,
						listening: true,
						speaking: false,
						transcript: "",
						error: null,
					},
				})}
			/>,
		);

		await revealPrompt();

		const voiceToggle = screen.getByRole("button", {
			name: "Stop voice input",
		});
		expect(voiceToggle.textContent).toBe("Listening");
		expect(voiceToggle.getAttribute("aria-pressed")).toBe("true");
		expect(voiceToggle.querySelector("svg")).toBeNull();
		expect(voiceToggle.className).toContain("bg-transparent");
	});
});
