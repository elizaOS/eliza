import {
  type ActionExample,
  type ActionResult,
  getActiveRoutingContextsForTurn,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  getSmartMusicFetchService,
  type MusicFetchProgress,
} from "../utils/smartFetchService";
import {
  confirmationRequired,
  isConfirmed,
  mergedOptions,
} from "./confirmation";

const DOWNLOAD_MUSIC_CONTEXTS = ["media", "files"] as const;
const DOWNLOAD_MUSIC_KEYWORDS = [
  "download",
  "fetch",
  "save",
  "grab",
  "music",
  "song",
  "track",
  "album",
  "library",
  "descargar",
  "guardar",
  "música",
  "canción",
  "télécharger",
  "musique",
  "chanson",
  "herunterladen",
  "speichern",
  "musik",
  "lied",
  "scaricare",
  "salvare",
  "baixar",
  "下载",
  "音乐",
  "保存",
  "ダウンロード",
  "音楽",
] as const;

function hasDownloadMusicContext(message: Memory, state?: State): boolean {
  const active = new Set(
    getActiveRoutingContextsForTurn(state, message).map((context) =>
      `${context}`.toLowerCase(),
    ),
  );
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") active.add(item.toLowerCase());
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  return DOWNLOAD_MUSIC_CONTEXTS.some((context) => active.has(context));
}

function hasDownloadMusicIntent(message: Memory, state?: State): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return DOWNLOAD_MUSIC_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

function readDownloadQuery(
  message: Memory,
  options?: Record<string, unknown>,
): string {
  const maxQueryLength = 200;
  const direct = readDirectDownloadQuery(options);
  if (direct) return direct.slice(0, maxQueryLength);
  return (message.content.text || "").trim().slice(0, maxQueryLength);
}

function readDirectDownloadQuery(
  options?: Record<string, unknown>,
): string | null {
  const merged = mergedOptions(options);
  const direct = merged.query ?? merged.searchQuery;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  return null;
}

export const downloadMusicSimiles = [
  "DOWNLOAD_MUSIC",
  "FETCH_MUSIC",
  "GET_MUSIC",
  "DOWNLOAD_SONG",
  "SAVE_MUSIC",
  "GRAB_MUSIC",
];

export async function validateDownloadMusic(
  _runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: Record<string, unknown>,
): Promise<boolean> {
  return (
    (readDirectDownloadQuery(options)?.length ?? 0) >= 3 ||
    hasDownloadMusicContext(message, state) ||
    hasDownloadMusicIntent(message, state)
  );
}

export async function handleDownloadMusic(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: Record<string, unknown> | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  if (!callback) return { success: false, error: "Missing callback" };

  const timeoutMs = 120_000;
  const query = readDownloadQuery(message, options);

  if (!query || query.length < 3) {
    await callback({
      text: "Please tell me what song you'd like to download (at least 3 characters).",
      source: message.content.source,
    });
    return;
  }

  const preview = `Confirmation required before downloading music to the library: "${query}".`;
  if (!isConfirmed(options)) {
    await callback({
      text: preview,
      source: message.content.source,
    });
    return confirmationRequired(preview, { op: "download", query });
  }

  try {
    const smartFetch = getSmartMusicFetchService(runtime);
    const preferredQuality =
      (runtime.getSetting("MUSIC_QUALITY_PREFERENCE") as string) || "mp3_320";

    await callback({
      text: `Searching for "${query}"...`,
      source: message.content.source,
    });

    let lastProgress = "";
    const onProgress = async (progress: MusicFetchProgress) => {
      const progressLabel = progress.stage || progress.message || "working";
      const statusText = progress.details
        ? `${progressLabel}: ${String(progress.details)}`
        : progressLabel;
      if (statusText !== lastProgress) {
        lastProgress = statusText;
        logger.info(`[DOWNLOAD_MUSIC] ${statusText}`);
        await callback({
          text: statusText,
          source: message.content.source,
        });
      }
    };

    const result = await Promise.race([
      smartFetch.fetchMusic({
        query,
        requestedBy: message.entityId,
        onProgress,
        preferredQuality: preferredQuality as "flac" | "mp3_320" | "any",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("music download timed out")),
          timeoutMs,
        ),
      ),
    ]);

    if (!result.success || !result.url) {
      await callback({
        text: `Couldn't find or download "${query}". ${result.error || "Please try a different search term."}`,
        source: message.content.source,
      });
      return;
    }

    let sourceText = "";
    if (result.source === "library") {
      sourceText = "Already in your library";
    } else if (result.source === "ytdlp") {
      sourceText = "Fetched from streaming service";
    } else if (result.source === "torrent") {
      sourceText = "Fetched via torrent";
    }

    const responseText = `**${result.title || query}** - ${sourceText}\nAvailable in your music library`;

    await runtime.createMemory(
      {
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          source: message.content.source,
          thought: `Downloaded music: ${result.title || query} (source: ${result.source})`,
          actions: ["MUSIC_LIBRARY"],
        },
        metadata: {
          type: "custom",
          actionName: "MUSIC_LIBRARY",
          legacyActionName: "DOWNLOAD_MUSIC",
          audioUrl: result.url,
          title: result.title || query,
          source: result.source,
        },
      },
      "messages",
    );

    await callback({
      text: responseText,
      source: message.content.source,
    });
    return { success: true, text: responseText };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error in DOWNLOAD_MUSIC action:", errorMessage);

    await callback({
      text: `I encountered an error while trying to download "${query}". ${errorMessage}`,
      source: message.content.source,
    });
    return { success: false, error: errorMessage };
  }
}

export const downloadMusicExamples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Download Comfortably Numb by Pink Floyd",
      },
    },
    {
      name: "{{name2}}",
      content: {
        text: "I'll download that to your library!",
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "fetch some Led Zeppelin for me",
      },
    },
    {
      name: "{{name2}}",
      content: {
        text: "Searching and downloading Led Zeppelin!",
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "grab the entire Dark Side of the Moon album",
      },
    },
    {
      name: "{{name2}}",
      content: {
        text: "I'll download that album for you!",
        actions: ["MUSIC_LIBRARY"],
      },
    },
  ],
];
