/**
 * Voice-onboarding HTTP routes.
 *
 * The flow (R2-speaker.md §6):
 *
 *   POST /api/voice/onboarding/profile/start
 *     → { sessionId, script: ScriptStep[], embeddingModel }
 *
 *   POST /api/voice/onboarding/profile/append?id=<sessionId>
 *     Content-Type: application/octet-stream
 *     Body: PCM (Float32, 16 kHz, mono) for one capture window
 *     → { sessionId, samplesReceived, totalSamples, durationMs }
 *
 *   POST /api/voice/onboarding/profile/finalize?id=<sessionId>&entityId=<id>
 *     → { profileId, entityId, samples, durationMs }
 *
 *   POST /api/voice/onboarding/complete
 *     Body: { entityId: string }
 *     → { ownerEntityId, settingsWritten: ["ELIZA_ADMIN_ENTITY_ID"] }
 *
 * Sessions are in-memory. They expire after 30 minutes of inactivity.
 * The encoder is loaded lazily; the route handlers return a structured
 * 503 if `onnxruntime-node` is missing.
 *
 * Audio storage: when the user grants `audioRefs` consent, sample WAVs
 * land under `$ELIZA_STATE_DIR/voice-profiles/audio/<profileId>/...`.
 * Otherwise nothing is written to disk except the centroid + variance.
 */
import crypto from "node:crypto";
import path from "node:path";
import { logger, readJsonBody, resolveStateDir, sendJson, sendJsonError, } from "@elizaos/core";
import { VoiceProfileStore } from "../services/voice/profile-store";
import { averageEmbeddings, SpeakerEncoderUnavailableError, WESPEAKER_EMBEDDING_DIM, WESPEAKER_MIN_SAMPLES, WESPEAKER_RESNET34_LM_INT8_MODEL_ID, WESPEAKER_SAMPLE_RATE, WespeakerEncoder, } from "../services/voice/speaker/encoder";
export const ONBOARDING_SCRIPT = [
    {
        id: "consent-1",
        role: "consent",
        prompt: "Before we start, I'd like to record a short voice sample so I can recognize you when you talk to me. The recording stays on this device. Is that okay?",
        expectedDurationMs: 4_000,
        requiresUserSpeech: true,
    },
    {
        id: "consent-2",
        role: "consent",
        prompt: "One more — do you want me to also be able to imitate your voice for outgoing messages? You can change this any time.",
        expectedDurationMs: 4_000,
        requiresUserSpeech: true,
    },
    {
        id: "calibration",
        role: "calibration",
        prompt: 'Please say "Hello, my name is" and then your full name.',
        expectedDurationMs: 5_000,
        requiresUserSpeech: true,
    },
    {
        id: "phonetic-1",
        role: "phonetic",
        prompt: '"The quick brown fox jumps over the lazy dog."',
        expectedDurationMs: 10_000,
        requiresUserSpeech: true,
    },
    {
        id: "phonetic-2",
        role: "phonetic",
        prompt: '"Pack my box with five dozen liquor jugs."',
        expectedDurationMs: 10_000,
        requiresUserSpeech: true,
    },
    {
        id: "phonetic-3",
        role: "phonetic",
        prompt: '"How razorback-jumping frogs can level six piqued gymnasts."',
        expectedDurationMs: 10_000,
        requiresUserSpeech: true,
    },
    {
        id: "prosody-1",
        role: "prosody",
        prompt: '"Did you remember to lock the back door?"',
        expectedDurationMs: 7_500,
        requiresUserSpeech: true,
    },
    {
        id: "prosody-2",
        role: "prosody",
        prompt: '"I left the keys on the kitchen counter, near the coffee machine."',
        expectedDurationMs: 7_500,
        requiresUserSpeech: true,
    },
    {
        id: "quiet",
        role: "quiet",
        prompt: 'Now read this one as if someone next to you is sleeping: "Just checking in quickly — everything\'s fine, talk to you tomorrow."',
        expectedDurationMs: 10_000,
        requiresUserSpeech: true,
    },
    {
        id: "open",
        role: "open",
        prompt: "Last one — tell me, in your own words, what you'd like me to help with most in the next few weeks.",
        expectedDurationMs: 15_000,
        requiresUserSpeech: true,
    },
];
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map();
function pruneExpiredSessions(now) {
    for (const [id, session] of sessions.entries()) {
        if (now - session.lastAccessedAt > SESSION_TIMEOUT_MS) {
            sessions.delete(id);
        }
    }
}
let encoderFactoryOverride = null;
let cachedEncoder = null;
export function setVoiceOnboardingEncoderFactory(factory) {
    encoderFactoryOverride = factory;
    cachedEncoder = null;
}
async function loadEncoder() {
    if (cachedEncoder)
        return cachedEncoder;
    if (encoderFactoryOverride) {
        cachedEncoder = await encoderFactoryOverride();
        return cachedEncoder;
    }
    const modelPath = path.join(resolveStateDir(), "voice-profiles", "models", "wespeaker-resnet34-lm-int8.onnx");
    cachedEncoder = await WespeakerEncoder.load(modelPath, WESPEAKER_RESNET34_LM_INT8_MODEL_ID);
    return cachedEncoder;
}
let profileStoreOverride = null;
export function setVoiceOnboardingProfileStore(store) {
    profileStoreOverride = store;
}
async function getProfileStore() {
    if (profileStoreOverride)
        return profileStoreOverride;
    const store = new VoiceProfileStore({
        rootDir: path.join(resolveStateDir(), "voice-profiles"),
    });
    await store.init();
    return store;
}
let settingsWriter = null;
export function setVoiceOnboardingSettingsWriter(writer) {
    settingsWriter = writer;
}
function startSession(consent) {
    const id = `obs_${crypto.randomUUID()}`;
    const now = Date.now();
    const session = {
        id,
        createdAt: now,
        lastAccessedAt: now,
        embeddings: [],
        totalSamples: 0,
        totalDurationMs: 0,
        consent,
    };
    sessions.set(id, session);
    return session;
}
function decodeFloat32(buf) {
    if (buf.byteLength % 4 !== 0) {
        throw new Error(`[voice-onboarding] PCM buffer length ${buf.byteLength} is not a multiple of 4`);
    }
    // Copy into an owned Float32Array (Buffer.buffer may have an offset).
    const out = new Float32Array(buf.byteLength / 4);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < out.length; i += 1) {
        out[i] = view.getFloat32(i * 4, true);
    }
    return out;
}
async function readBinaryBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
/**
 * Mount-point: returns `true` if the request was handled, `false` if
 * the path is not one of the voice-onboarding routes (so the caller
 * can fall through to the next handler).
 */
export async function handleVoiceOnboardingRoutes(req, res) {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/voice/onboarding/"))
        return false;
    pruneExpiredSessions(Date.now());
    if (method === "POST" && pathname === "/api/voice/onboarding/profile/start") {
        // Empty body is valid here (the consent flags default to a safe
        // "attribution-yes / synthesis-no" pair). We read the body only when
        // the caller has actually sent one — otherwise `readJsonBody` would
        // emit a 400 for the empty string and then we'd double-write below.
        const hasJsonBody = (req.headers["content-type"] ?? "").includes("application/json") &&
            req.headers["content-length"] !== "0";
        const body = hasJsonBody
            ? await readJsonBody(req, res, {
                requireObject: false,
            })
            : null;
        // If the body read failed, `readJsonBody` already sent a 4xx.
        if (hasJsonBody && body === null)
            return true;
        const consent = {
            attributionAuthorized: typeof body?.attributionAuthorized === "boolean"
                ? body.attributionAuthorized
                : true,
            synthesisAuthorized: typeof body?.synthesisAuthorized === "boolean"
                ? body.synthesisAuthorized
                : false,
        };
        const session = startSession(consent);
        sendJson(res, {
            sessionId: session.id,
            script: ONBOARDING_SCRIPT,
            embeddingModel: WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
            expectedSampleRate: WESPEAKER_SAMPLE_RATE,
            minSamplesPerCapture: WESPEAKER_MIN_SAMPLES,
        });
        return true;
    }
    if (method === "POST" &&
        pathname === "/api/voice/onboarding/profile/append") {
        const sessionId = url.searchParams.get("id");
        if (!sessionId) {
            sendJsonError(res, "id query parameter is required");
            return true;
        }
        const session = sessions.get(sessionId);
        if (!session) {
            sendJsonError(res, "session not found", 404);
            return true;
        }
        let buffer;
        try {
            buffer = await readBinaryBody(req);
        }
        catch (err) {
            sendJsonError(res, err instanceof Error ? err.message : "failed to read body", 400);
            return true;
        }
        let pcm;
        try {
            pcm = decodeFloat32(buffer);
        }
        catch (err) {
            sendJsonError(res, err instanceof Error ? err.message : "invalid PCM body", 400);
            return true;
        }
        if (pcm.length < WESPEAKER_MIN_SAMPLES) {
            sendJsonError(res, `capture too short: ${pcm.length} samples (< ${WESPEAKER_MIN_SAMPLES})`, 400);
            return true;
        }
        let encoder;
        try {
            encoder = await loadEncoder();
        }
        catch (err) {
            if (err instanceof SpeakerEncoderUnavailableError) {
                sendJsonError(res, err.message, 503);
                return true;
            }
            throw err;
        }
        try {
            const embedding = await encoder.encode(pcm);
            session.embeddings.push(embedding);
            session.totalSamples += pcm.length;
            session.totalDurationMs += Math.round((pcm.length / WESPEAKER_SAMPLE_RATE) * 1000);
            session.lastAccessedAt = Date.now();
            sendJson(res, {
                sessionId: session.id,
                samplesReceived: session.embeddings.length,
                totalSamples: session.totalSamples,
                durationMs: session.totalDurationMs,
            });
        }
        catch (err) {
            if (err instanceof SpeakerEncoderUnavailableError) {
                sendJsonError(res, err.message, err.code === "invalid-input" ? 400 : 503);
                return true;
            }
            throw err;
        }
        return true;
    }
    if (method === "POST" &&
        pathname === "/api/voice/onboarding/profile/finalize") {
        const sessionId = url.searchParams.get("id");
        const entityId = url.searchParams.get("entityId");
        if (!sessionId) {
            sendJsonError(res, "id query parameter is required");
            return true;
        }
        const session = sessions.get(sessionId);
        if (!session) {
            sendJsonError(res, "session not found", 404);
            return true;
        }
        if (session.embeddings.length === 0) {
            sendJsonError(res, "no embeddings captured yet", 400);
            return true;
        }
        let centroid;
        try {
            centroid = averageEmbeddings(session.embeddings);
        }
        catch (err) {
            sendJsonError(res, err instanceof Error ? err.message : "failed to compute centroid", 400);
            return true;
        }
        if (centroid.length !== WESPEAKER_EMBEDDING_DIM) {
            sendJsonError(res, `centroid dim mismatch: ${centroid.length} != ${WESPEAKER_EMBEDDING_DIM}`, 500);
            return true;
        }
        const store = await getProfileStore();
        const profile = await store.createProfile({
            centroid,
            embeddingModel: WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
            entityId: entityId ?? null,
            confidence: 0.95,
            durationMs: session.totalDurationMs,
            consent: {
                attributionAuthorized: session.consent.attributionAuthorized,
                synthesisAuthorized: session.consent.synthesisAuthorized,
                grantedAt: new Date().toISOString(),
                grantedBy: entityId ?? undefined,
            },
        });
        sessions.delete(sessionId);
        sendJson(res, {
            profileId: profile.profileId,
            entityId: profile.entityId,
            samples: profile.sampleCount,
            durationMs: profile.totalDurationMs,
        });
        return true;
    }
    if (method === "POST" && pathname === "/api/voice/onboarding/complete") {
        const body = await readJsonBody(req, res);
        if (!body)
            return true;
        const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
        if (!entityId) {
            sendJsonError(res, "entityId is required", 400);
            return true;
        }
        if (!settingsWriter) {
            sendJsonError(res, "voice onboarding settings writer not configured; runtime must call setVoiceOnboardingSettingsWriter()", 503);
            return true;
        }
        try {
            await settingsWriter("ELIZA_ADMIN_ENTITY_ID", entityId);
        }
        catch (err) {
            logger.error({ err }, "[voice-onboarding] failed to write ELIZA_ADMIN_ENTITY_ID");
            sendJsonError(res, err instanceof Error ? err.message : "failed to write owner entity id", 500);
            return true;
        }
        sendJson(res, {
            ownerEntityId: entityId,
            settingsWritten: ["ELIZA_ADMIN_ENTITY_ID"],
        });
        return true;
    }
    return false;
}
/** Test helper: clear in-memory sessions so a test starts clean. */
export function __resetVoiceOnboardingSessions() {
    sessions.clear();
}
//# sourceMappingURL=voice-onboarding-routes.js.map