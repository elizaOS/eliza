import {
    elizaLogger,
    IAgentRuntime,
    composeContext,
    generateText,
    ModelClass,
    ServiceType,
    ITranscriptionService,
} from "@elizaos/core";
import { ClientBase } from "./base";
import {
    Scraper,
    Space,
    SpaceConfig,
    RecordToDiskPlugin,
    IdleMonitorPlugin,
    SpeakerRequest,
} from "agent-twitter-client";
import {
    SttTtsPlugin
} from './plugins/SttTtsSpacesPlugin.ts';

interface SpaceDecisionOptions {
    maxSpeakers?: number;
    topics?: string[];
    typicalDurationMinutes?: number;
    idleKickTimeoutMs?: number;
    minIntervalBetweenSpacesMinutes?: number;
    businessHoursOnly?: boolean;
    randomChance?: number;
    enableIdleMonitor?: boolean;
    enableSttTts?: boolean;
    enableRecording?: boolean;
    voiceId?: string;
    sttLanguage?: string;
    gptModel?: string;
    systemPrompt?: string;
    speakerMaxDurationMs?: number;
}

interface CurrentSpeakerState {
    userId: string;
    sessionUUID: string;
    username: string;
    startTime: number;
}

/**
 * Generate short filler text via GPT
 */
async function generateFiller(runtime: IAgentRuntime, fillerType: string): Promise<string> {
    try {
        const context = composeContext({
            state: { fillerType },
            template: `
# INSTRUCTIONS:
You are generating a short filler message for a Twitter Space. The filler type is "{{fillerType}}".
Keep it brief, friendly, and relevant. No more than two sentences.
Only return the text, no additional formatting.

---
`,
        });
        const output = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        return output.trim();
    } catch (err) {
        elizaLogger.error("[generateFiller] Error generating filler:", err);
        return "";
    }
}

/**
 * Speak a filler message if STT/TTS plugin is available. Sleep a bit after TTS to avoid cutoff.
 */
async function speakFiller(
    runtime: IAgentRuntime,
    sttTtsPlugin: SttTtsPlugin | undefined,
    fillerType: string,
    sleepAfterMs = 3000
): Promise<void> {
    if (!sttTtsPlugin) return;
    const text = await generateFiller(runtime, fillerType);
    if (!text) return;

    elizaLogger.log(`[Space] Filler (${fillerType}) => ${text}`);
    await sttTtsPlugin.speakText(text);

    if (sleepAfterMs > 0) {
        await new Promise((res) => setTimeout(res, sleepAfterMs));
    }
}

/**
 * Generate topic suggestions via GPT if no topics are configured
 */
async function generateTopicsIfEmpty(runtime: IAgentRuntime): Promise<string[]> {
    try {
        const context = composeContext({
            state: {},
            template: `
# INSTRUCTIONS:
Please generate 5 short topic ideas for a Twitter Space about technology or random interesting subjects.
Return them as a comma-separated list, no additional formatting or numbering.

Example:
"AI Advances, Futuristic Gadgets, Space Exploration, Quantum Computing, Digital Ethics"
---
`,
        });
        const response = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        const topics = response
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        return topics.length ? topics : ["Random Tech Chat", "AI Thoughts"];
    } catch (err) {
        elizaLogger.error("[generateTopicsIfEmpty] GPT error =>", err);
        return ["Random Tech Chat", "AI Thoughts"];
    }
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
export class TwitterSpaceClient {
    private client: ClientBase;
    private scraper: Scraper;
    private isSpaceRunning = false;
    private currentSpace?: Space;
    private spaceId?: string;
    private startedAt?: number;
    private checkInterval?: NodeJS.Timeout;
    private lastSpaceEndedAt?: number;
    private sttTtsPlugin?: SttTtsPlugin;

    /**
     * We now store an array of active speakers, not just 1
     */
    private activeSpeakers: CurrentSpeakerState[] = [];
    private speakerQueue: SpeakerRequest[] = [];

    private decisionOptions: SpaceDecisionOptions;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.scraper = client.twitterClient;

        const charSpaces = runtime.character.twitterSpaces || {};
        this.decisionOptions = {
            maxSpeakers: charSpaces.maxSpeakers ?? 1,
            topics: charSpaces.topics ?? [],
            typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
            idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 60_000,
            minIntervalBetweenSpacesMinutes: charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
            businessHoursOnly: charSpaces.businessHoursOnly ?? false,
            randomChance: charSpaces.randomChance ?? 0.3,
            enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
            enableSttTts: charSpaces.enableSttTts !== false,
            enableRecording: charSpaces.enableRecording !== false,
            voiceId: charSpaces.voiceId || runtime.character.settings.voice.model || 'Xb7hH8MSUJpSbSDYk0k2',
            sttLanguage: charSpaces.sttLanguage || "en",
            gptModel: charSpaces.gptModel,
            systemPrompt: charSpaces.systemPrompt,
            speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 60_000,
        };
    }

    /**
     * Periodic check to launch or manage space
     */
    public async startPeriodicSpaceCheck() {
        elizaLogger.log("[Space] Starting periodic check routine...");

        // For instance:
        const intervalMsWhenIdle = 5 * 60_000;  // 5 minutes if no Space is running
        const intervalMsWhenRunning = 5_000;   // 5 seconds if a Space IS running

        const routine = async () => {
            try {
                if (!this.isSpaceRunning) {
                    // Space not running => check if we should launch
                    const launch = await this.shouldLaunchSpace();
                    if (launch) {
                        const config = await this.generateSpaceConfig();
                        await this.startSpace(config);
                    }
                    // Plan next iteration with a slower pace
                    this.checkInterval = setTimeout(routine, this.isSpaceRunning ? intervalMsWhenRunning : intervalMsWhenIdle);
                } else {
                    // Space is running => manage it more frequently
                    await this.manageCurrentSpace();
                    // Plan next iteration with a faster pace
                    this.checkInterval = setTimeout(routine, intervalMsWhenRunning);
                }
            } catch (error) {
                elizaLogger.error("[Space] Error in routine =>", error);
                // In case of error, still schedule next iteration
                this.checkInterval = setTimeout(routine, intervalMsWhenIdle);
            }
        };

        routine();
    }

    stopPeriodicCheck() {
        if (this.checkInterval) {
            clearTimeout(this.checkInterval);
            this.checkInterval = undefined;
        }
    }

    private async shouldLaunchSpace(): Promise<boolean> {
        // Random chance
        const r = Math.random();
        if (r > (this.decisionOptions.randomChance ?? 0.3)) {
            elizaLogger.log("[Space] Random check => skip launching");
            return false;
        }
        // Business hours
        if (this.decisionOptions.businessHoursOnly) {
            const hour = new Date().getUTCHours();
            if (hour < 9 || hour >= 17) {
                elizaLogger.log("[Space] Out of business hours => skip");
                return false;
            }
        }
        // Interval
        const now = Date.now();
        if (this.lastSpaceEndedAt) {
            const minIntervalMs =
                (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) * 60_000;
            if (now - this.lastSpaceEndedAt < minIntervalMs) {
                elizaLogger.log("[Space] Too soon since last space => skip");
                return false;
            }
        }

        elizaLogger.log("[Space] Deciding to launch a new Space...");
        return true;
    }

    private async generateSpaceConfig(): Promise<SpaceConfig> {
        if (
            !this.decisionOptions.topics ||
            this.decisionOptions.topics.length === 0
        ) {
            const newTopics = await generateTopicsIfEmpty(this.client.runtime);
            this.decisionOptions.topics = newTopics;
        }

        let chosenTopic = "Random Tech Chat";
        if (
            this.decisionOptions.topics &&
            this.decisionOptions.topics.length > 0
        ) {
            chosenTopic =
                this.decisionOptions.topics[
                    Math.floor(Math.random() * this.decisionOptions.topics.length)
                    ];
        }

        return {
            mode: "INTERACTIVE",
            title: chosenTopic,
            description: `Discussion about ${chosenTopic}`,
            languages: ["en"],
        };
    }

    public async startSpace(config: SpaceConfig) {
        elizaLogger.log("[Space] Starting a new Twitter Space...");

        try {
            this.currentSpace = new Space(this.scraper);
            this.isSpaceRunning = false;
            this.spaceId = undefined;
            this.startedAt = Date.now();

            // Reset states
            this.activeSpeakers = [];
            this.speakerQueue = [];

            // Retrieve keys
            const openAiKey = process.env.OPENAI_API_KEY || "";
            const elevenLabsKey = process.env.ELEVENLABS_XI_API_KEY || "";

            // Plugins
            if (this.decisionOptions.enableRecording) {
                elizaLogger.log("[Space] Using RecordToDiskPlugin");
                this.currentSpace.use(new RecordToDiskPlugin());
            }

            if (this.decisionOptions.enableSttTts) {
                elizaLogger.log("[Space] Using SttTtsPlugin");
                const sttTts = new SttTtsPlugin();
                this.sttTtsPlugin = sttTts;
                this.currentSpace.use(sttTts, {
                    openAiApiKey: openAiKey,
                    elevenLabsApiKey: elevenLabsKey,
                    voiceId: this.decisionOptions.voiceId,
                    gptModel: this.decisionOptions.gptModel,
                    systemPrompt: this.decisionOptions.systemPrompt,
                    sttLanguage: this.decisionOptions.sttLanguage,
                    transcriptionService: this.client.runtime.getService<ITranscriptionService>(
                        ServiceType.TRANSCRIPTION,
                    )
                });
            }

            if (this.decisionOptions.enableIdleMonitor) {
                elizaLogger.log("[Space] Using IdleMonitorPlugin");
                this.currentSpace.use(
                    new IdleMonitorPlugin(
                        this.decisionOptions.idleKickTimeoutMs ?? 60_000,
                        10_000
                    )
                );
            }

            const broadcastInfo = await this.currentSpace.initialize(config);
            this.spaceId = broadcastInfo.room_id;
            this.isSpaceRunning = true;
            await this.scraper.sendTweet(broadcastInfo.share_url.replace('broadcasts', 'spaces'));

            const spaceUrl = broadcastInfo.share_url.replace("broadcasts", "spaces");
            elizaLogger.log(`[Space] Space started => ${spaceUrl}`);

            // Greet
            await speakFiller(this.client.runtime, this.sttTtsPlugin, "WELCOME");

            // Events
            this.currentSpace.on("occupancyUpdate", (update) => {
                elizaLogger.log(`[Space] Occupancy => ${update.occupancy} participant(s).`);
            });

            this.currentSpace.on("speakerRequest", async (req: SpeakerRequest) => {
                elizaLogger.log(`[Space] Speaker request from @${req.username} (${req.userId}).`);
                await this.handleSpeakerRequest(req);
            });

            this.currentSpace.on("idleTimeout", async (info) => {
                elizaLogger.log(`[Space] idleTimeout => no audio for ${info.idleMs} ms.`);
                await speakFiller(this.client.runtime, this.sttTtsPlugin, "IDLE_ENDING");
                await this.stopSpace();
            });

            process.on("SIGINT", async () => {
                elizaLogger.log("[Space] SIGINT => stopping space");
                await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING");
                await this.stopSpace();
                process.exit(0);
            });
        } catch (error) {
            elizaLogger.error("[Space] Error launching Space =>", error);
            this.isSpaceRunning = false;
            throw error;
        }
    }

    /**
     * Periodic management: check durations, remove extras, maybe accept new from queue
     */
    private async manageCurrentSpace() {
        if (!this.spaceId || !this.currentSpace) return;
        try {
            const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
            const { participants } = audioSpace;
            const numSpeakers = participants.speakers?.length || 0;
            const totalListeners = participants.listeners?.length || 0;

            // 1) Remove any speaker who exceeded speakerMaxDurationMs
            const maxDur = this.decisionOptions.speakerMaxDurationMs ?? 240_000;
            const now = Date.now();

            for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
                const speaker = this.activeSpeakers[i];
                const elapsed = now - speaker.startTime;
                if (elapsed > maxDur) {
                    elizaLogger.log(
                        `[Space] Speaker @${speaker.username} exceeded max duration => removing`
                    );
                    await this.removeSpeaker(speaker.userId);
                    this.activeSpeakers.splice(i, 1);

                    // Possibly speak a short "SPEAKER_LEFT" filler
                    await speakFiller(this.client.runtime, this.sttTtsPlugin, "SPEAKER_LEFT");
                }
            }

            // 2) If we have capacity for new speakers from the queue, accept them
            await this.acceptSpeakersFromQueueIfNeeded();

            // 3) If somehow more than maxSpeakers are active, remove the extras
            if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
                elizaLogger.log("[Space] More than maxSpeakers => removing extras...");
                await this.kickExtraSpeakers(participants.speakers);
            }

            // 4) Possibly stop the space if empty or time exceeded
            const elapsedMinutes = (now - (this.startedAt || 0)) / 60000;
            if (
                elapsedMinutes > (this.decisionOptions.typicalDurationMinutes ?? 30) ||
                (numSpeakers === 0 && totalListeners === 0 && elapsedMinutes > 5)
            ) {
                elizaLogger.log("[Space] Condition met => stopping the Space...");
                await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING", 4000);
                await this.stopSpace();
            }
        } catch (error) {
            elizaLogger.error("[Space] Error in manageCurrentSpace =>", error);
        }
    }

    /**
     * If we have available slots, accept new speakers from the queue
     */
    private async acceptSpeakersFromQueueIfNeeded() {
        // while queue not empty and activeSpeakers < maxSpeakers, accept next
        const ms = this.decisionOptions.maxSpeakers ?? 1;
        while (this.speakerQueue.length > 0 && this.activeSpeakers.length < ms) {
            const nextReq = this.speakerQueue.shift();
            if (nextReq) {
                await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
                await this.acceptSpeaker(nextReq);
            }
        }
    }

    private async handleSpeakerRequest(req: SpeakerRequest) {
        if (!this.spaceId || !this.currentSpace) return;

        const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
        const janusSpeakers = audioSpace?.participants?.speakers || [];

        // If we haven't reached maxSpeakers, accept immediately
        if (janusSpeakers.length < (this.decisionOptions.maxSpeakers ?? 1)) {
            elizaLogger.log(`[Space] Accepting speaker @${req.username} now`);
            await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
            await this.acceptSpeaker(req);
        } else {
            elizaLogger.log(`[Space] Adding speaker @${req.username} to the queue`);
            this.speakerQueue.push(req);
        }
    }

    private async acceptSpeaker(req: SpeakerRequest) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.approveSpeaker(req.userId, req.sessionUUID);
            this.activeSpeakers.push({
                userId: req.userId,
                sessionUUID: req.sessionUUID,
                username: req.username,
                startTime: Date.now(),
            });
            elizaLogger.log(`[Space] Speaker @${req.username} is now live`);
        } catch (err) {
            elizaLogger.error(`[Space] Error approving speaker @${req.username}:`, err);
        }
    }

    private async removeSpeaker(userId: string) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.removeSpeaker(userId);
            elizaLogger.log(`[Space] Removed speaker userId=${userId}`);
        } catch (error) {
            elizaLogger.error(`[Space] Error removing speaker userId=${userId} =>`, error);
        }
    }

    /**
     * If more than maxSpeakers are found, remove extras
     * Also update activeSpeakers array
     */
    private async kickExtraSpeakers(speakers: any[]) {
        if (!this.currentSpace) return;
        const ms = this.decisionOptions.maxSpeakers ?? 1;

        // sort by who joined first if needed, or just slice
        const extras = speakers.slice(ms);
        for (const sp of extras) {
            elizaLogger.log(`[Space] Removing extra speaker => userId=${sp.user_id}`);
            await this.removeSpeaker(sp.user_id);

            // remove from activeSpeakers array
            const idx = this.activeSpeakers.findIndex((s) => s.userId === sp.user_id);
            if (idx !== -1) {
                this.activeSpeakers.splice(idx, 1);
            }
        }
    }

    public async stopSpace() {
        if (!this.currentSpace || !this.isSpaceRunning) return;
        try {
            elizaLogger.log("[Space] Stopping the current Space...");
            await this.currentSpace.stop();
        } catch (err) {
            elizaLogger.error("[Space] Error stopping Space =>", err);
        } finally {
            this.isSpaceRunning = false;
            this.spaceId = undefined;
            this.currentSpace = undefined;
            this.startedAt = undefined;
            this.lastSpaceEndedAt = Date.now();
            this.activeSpeakers = [];
            this.speakerQueue = [];
        }
    }
}
