/**
 * VoiceSpatialView — the voice/transcription surface authored once with the
 * spatial vocabulary (GUI / XR / TUI), purely presentational over a snapshot.
 *
 * It surfaces the EXISTING voice configuration (provider, mode, ASR) from
 * `GET /api/config` plus the most recent transcript lines a host chooses to push
 * via `setVoiceTerminalSnapshot`. It does NOT open a microphone or run ASR — the
 * live capture pipeline is browser-side (WebRTC + AudioContext) and out of reach
 * of the Node terminal; this view renders the state that pipeline produces.
 */

import {
	Card,
	Divider,
	HStack,
	List,
	type SpatialTone,
	Text,
	VStack,
} from "@elizaos/ui/spatial";

/** A finalized transcript line surfaced for display. */
export interface TranscriptLine {
	speaker: string;
	text: string;
}

export interface VoiceSnapshot {
	provider?: string;
	mode?: string;
	asrProvider?: string;
	/** "ready" once a TTS/ASR provider is configured, else "unconfigured". */
	status?: "ready" | "unconfigured" | "error";
	/** Recent finalized transcript lines (most recent last). */
	transcript: TranscriptLine[];
	error?: string | null;
}

export const EMPTY_VOICE_SNAPSHOT: VoiceSnapshot = {
	status: "unconfigured",
	transcript: [],
};

function statusTone(status: VoiceSnapshot["status"]): SpatialTone {
	if (status === "ready") return "success";
	if (status === "error") return "danger";
	return "muted";
}

export interface VoiceSpatialViewProps {
	snapshot: VoiceSnapshot;
}

export function VoiceSpatialView({ snapshot }: VoiceSpatialViewProps) {
	const transcript = snapshot.transcript;
	return (
		<Card gap={1} padding={1}>
			<HStack gap={1} align="center">
				<Text style="caption" tone={statusTone(snapshot.status)} grow={1}>
					{snapshot.status ?? "unconfigured"}
				</Text>
				<Text style="caption" tone="muted">
					voice
				</Text>
			</HStack>

			{snapshot.error ? (
				<Text tone="danger" style="caption">
					{snapshot.error}
				</Text>
			) : null}

			<Divider label="config" />
			<List gap={0}>
				<HStack gap={1} align="center">
					<Text grow={1} wrap={false}>
						Provider
					</Text>
					<Text tone="muted" wrap={false}>
						{snapshot.provider ?? "—"}
					</Text>
				</HStack>
				<HStack gap={1} align="center">
					<Text grow={1} wrap={false}>
						Mode
					</Text>
					<Text tone="muted" wrap={false}>
						{snapshot.mode ?? "—"}
					</Text>
				</HStack>
				<HStack gap={1} align="center">
					<Text grow={1} wrap={false}>
						ASR
					</Text>
					<Text tone="muted" wrap={false}>
						{snapshot.asrProvider ?? "—"}
					</Text>
				</HStack>
			</List>

			<Divider label="transcript" />
			{transcript.length === 0 ? (
				<Text tone="muted" align="center" style="caption">
					No transcript yet
				</Text>
			) : (
				<VStack gap={0}>
					{transcript.slice(-8).map((line) => (
						<Text key={`${line.speaker}:${line.text}`} wrap={false}>
							{`${line.speaker}: ${line.text}`}
						</Text>
					))}
				</VStack>
			)}
		</Card>
	);
}

export default VoiceSpatialView;
