/**
 * MANAGE_BROWSER_BRIDGE — single action that covers the bridge-extension
 * management surface (Install, Reveal Folder, Open Manager, Refresh) that the
 * `BrowserWorkspaceView` UI exposes.
 *
 * This replaces the four previously-separate actions
 * (`BROWSER_BRIDGE_INSTALL`, `BROWSER_BRIDGE_REVEAL_FOLDER`,
 * `BROWSER_BRIDGE_OPEN_MANAGER`, `BROWSER_BRIDGE_REFRESH`) — folded into one
 * because each one took zero parameters and only differed in which packaging
 * helper it called. One action with a `subaction` parameter is the right
 * agent surface; the LLM picks the subaction.
 *
 * Calls directly into the local packaging helpers (the same code path the
 * route layer uses) rather than going back through HTTP, so the action runs
 * inside the runtime process without an HTTP round trip.
 *
 * Authorization: OWNER only. The bridge is local-machine plumbing —
 * installing a browser extension, opening Chrome's extensions page,
 * inspecting paired companions — that should never be triggered by a
 * non-owner user.
 *
 * Validation: keyword-based on the message (and recent messages) using a
 * deliberately liberal multilingual set covering "browser", "bridge",
 * "chrome / safari / firefox / brave / edge / arc / opera / vivaldi",
 * "extension", "companion", "install", "manager", "reveal", "refresh",
 * "connection", "pair", and Spanish / French / German / Italian / Japanese /
 * Chinese / Korean / Portuguese / Russian / Arabic / Hindi / Turkish /
 * Vietnamese / Thai / Polish / Dutch / Indonesian / Hebrew variants.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
} from "../contracts.js";
import {
  buildBrowserBridgeCompanionPackage,
  getBrowserBridgeCompanionPackageStatus,
  openBrowserBridgeCompanionManager,
  openBrowserBridgeCompanionPackagePath,
} from "../packaging.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "../service.js";

const ACTION_NAME = "MANAGE_BROWSER_BRIDGE";
const MAX_BROWSER_BRIDGE_TEXT_LENGTH = 3000;
const BROWSER_BRIDGE_TIMEOUT_MS = 30_000;

export const BROWSER_BRIDGE_SUBACTIONS = [
  "install",
  "reveal_folder",
  "open_manager",
  "refresh",
] as const;
export type BrowserBridgeSubaction = (typeof BROWSER_BRIDGE_SUBACTIONS)[number];

const BROWSER_BRIDGE_KEYWORDS = [
  // English — concept
  "browser",
  "browsers",
  "browser bridge",
  "agent browser bridge",
  "bridge",
  "extension",
  "extensions",
  "companion",
  "companions",
  "connection",
  "pair",
  "paired",
  "pairing",
  // English — browser brands
  "chrome",
  "safari",
  "firefox",
  "brave",
  "edge",
  "arc",
  "opera",
  "vivaldi",
  // English — actions
  "install",
  "installer",
  "installed",
  "uninstall",
  "reveal",
  "show folder",
  "open folder",
  "open manager",
  "manager",
  "refresh",
  "reload",
  "reconnect",
  "connect",
  "disconnect",
  "status",
  "settings",
  "setting",
  "configuration",
  "config",
  "folder",
  "load unpacked",
  "chrome://extensions",
  // Spanish
  "navegador",
  "navegadores",
  "extensión",
  "extensiones",
  "instalar",
  "instalador",
  "desinstalar",
  "carpeta",
  "actualizar",
  "conectar",
  "conexión",
  "puente",
  // French
  "navigateur",
  "navigateurs",
  "installer",
  "désinstaller",
  "dossier",
  "actualiser",
  "rafraîchir",
  "connexion",
  "pont",
  // German
  "browser",
  "erweiterung",
  "erweiterungen",
  "installieren",
  "deinstallieren",
  "ordner",
  "aktualisieren",
  "verbindung",
  "brücke",
  // Italian
  "navigatore",
  "estensione",
  "estensioni",
  "installare",
  "disinstallare",
  "cartella",
  "aggiornare",
  "collegamento",
  "ponte",
  // Portuguese
  "navegador",
  "extensão",
  "extensões",
  "instalar",
  "pasta",
  "atualizar",
  "conexão",
  "ponte",
  // Russian
  "браузер",
  "расширение",
  "установить",
  "обновить",
  "папка",
  "соединение",
  "мост",
  // Japanese
  "ブラウザ",
  "拡張機能",
  "インストール",
  "フォルダ",
  "更新",
  "接続",
  "ブリッジ",
  // Chinese (simplified + traditional)
  "浏览器",
  "瀏覽器",
  "扩展",
  "擴充",
  "安装",
  "安裝",
  "文件夹",
  "資料夾",
  "刷新",
  "重新整理",
  "连接",
  "連線",
  "桥",
  "橋",
  // Korean
  "브라우저",
  "확장",
  "설치",
  "폴더",
  "새로고침",
  "연결",
  "브리지",
  // Arabic
  "متصفح",
  "إضافة",
  "تثبيت",
  "مجلد",
  "تحديث",
  "اتصال",
  "جسر",
  // Hindi
  "ब्राउज़र",
  "एक्सटेंशन",
  "इंस्टॉल",
  "फ़ोल्डर",
  "रिफ्रेश",
  "कनेक्शन",
  // Turkish
  "tarayıcı",
  "uzantı",
  "yükle",
  "klasör",
  "yenile",
  "bağlantı",
  "köprü",
  // Vietnamese
  "trình duyệt",
  "tiện ích",
  "cài đặt",
  "thư mục",
  "làm mới",
  "kết nối",
  "cầu nối",
  // Thai
  "เบราว์เซอร์",
  "ส่วนขยาย",
  "ติดตั้ง",
  "โฟลเดอร์",
  "รีเฟรช",
  "เชื่อมต่อ",
  // Polish
  "przeglądarka",
  "rozszerzenie",
  "zainstaluj",
  "folder",
  "odśwież",
  "połączenie",
  "most",
  // Dutch
  "browser",
  "extensie",
  "installeer",
  "map",
  "vernieuw",
  "verbinding",
  "brug",
  // Indonesian / Malay
  "peramban",
  "penjelajah",
  "ekstensi",
  "pasang",
  "folder",
  "muat ulang",
  "koneksi",
  "jembatan",
  // Hebrew
  "דפדפן",
  "הרחבה",
  "התקנה",
  "תיקייה",
  "רענון",
  "חיבור",
] as const;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withBrowserBridgeTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out`)),
        BROWSER_BRIDGE_TIMEOUT_MS,
      ),
    ),
  ]);
}

const SELECTED_CONTEXT_KEYS = [
  "browser",
  "files",
  "connectors",
  "settings",
  "automation",
  "admin",
] as const;

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return SELECTED_CONTEXT_KEYS.some((context) => selected.has(context));
}

function hasBrowserBridgeIntent(
  message: Memory,
  state: State | undefined,
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return BROWSER_BRIDGE_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

type ManageBrowserBridgeParameters = {
  subaction?: BrowserBridgeSubaction;
};

function normalizeSubaction(
  raw: string | undefined,
): BrowserBridgeSubaction | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (BROWSER_BRIDGE_SUBACTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as BrowserBridgeSubaction)
    : null;
}

function inferSubactionFromMessage(text: string): BrowserBridgeSubaction {
  const normalized = text.toLowerCase();
  if (
    /\b(reveal|show|open).{0,12}(folder|build folder|directory)\b/.test(
      normalized,
    ) &&
    !/\bextension manager\b/.test(normalized)
  ) {
    return "reveal_folder";
  }
  if (
    /\bopen.{0,8}(extensions?|extension manager|chrome:\/\/extensions)\b/.test(
      normalized,
    )
  ) {
    return "open_manager";
  }
  if (
    /\b(refresh|reload|reconnect|status|settings?|config(?:uration)?|update|sync|update status|connection state)\b/.test(
      normalized,
    )
  ) {
    return "refresh";
  }
  return "install";
}

async function runInstall(): Promise<ActionResult> {
  let status: BrowserBridgeCompanionPackageStatus =
    getBrowserBridgeCompanionPackageStatus();
  if (!status.chromeBuildPath) {
    status = await withBrowserBridgeTimeout(
      buildBrowserBridgeCompanionPackage("chrome"),
      "browser bridge package build",
    );
  }
  const reveal = await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionPackagePath("chrome_build", { revealOnly: true }),
    "browser bridge reveal",
  );
  let openedManager = true;
  try {
    await withBrowserBridgeTimeout(
      openBrowserBridgeCompanionManager("chrome"),
      "browser bridge manager open",
    );
  } catch (err) {
    openedManager = false;
    logger.warn(
      `[${ACTION_NAME}] could not open chrome://extensions: ${describeError(err)}`,
    );
  }
  const text = (
    openedManager
      ? `Chrome is ready. Click Load unpacked and choose ${reveal.path}.`
      : `The Agent Browser Bridge folder is ready at ${reveal.path}. Open chrome://extensions, click Load unpacked, and choose that folder.`
  ).slice(0, MAX_BROWSER_BRIDGE_TEXT_LENGTH);
  return {
    text,
    success: true,
    values: { success: true, subaction: "install", openedManager },
    data: {
      actionName: ACTION_NAME,
      subaction: "install",
      path: reveal.path,
      openedManager,
      status,
    },
  };
}

async function runRevealFolder(): Promise<ActionResult> {
  const reveal = await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionPackagePath("chrome_build", { revealOnly: true }),
    "browser bridge reveal",
  );
  const text =
    `Revealed the Agent Browser Bridge folder at ${reveal.path}.`.slice(
      0,
      MAX_BROWSER_BRIDGE_TEXT_LENGTH,
    );
  return {
    text,
    success: true,
    values: { success: true, subaction: "reveal_folder" },
    data: {
      actionName: ACTION_NAME,
      subaction: "reveal_folder",
      path: reveal.path,
    },
  };
}

async function runOpenManager(): Promise<ActionResult> {
  await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionManager("chrome"),
    "browser bridge manager open",
  );
  const text =
    "Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder.".slice(
      0,
      MAX_BROWSER_BRIDGE_TEXT_LENGTH,
    );
  return {
    text,
    success: true,
    values: { success: true, subaction: "open_manager" },
    data: { actionName: ACTION_NAME, subaction: "open_manager" },
  };
}

async function runRefresh(runtime: IAgentRuntime): Promise<ActionResult> {
  const status = getBrowserBridgeCompanionPackageStatus();
  let settings:
    | Awaited<ReturnType<BrowserBridgeRouteService["getBrowserSettings"]>>
    | null = null;
  let companions: BrowserBridgeCompanionStatus[] = [];
  const service = runtime.getService<BrowserBridgeRouteService>(
    BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  );
  if (!service) {
    return {
      text: "Agent Browser Bridge package status is available, but companion status cannot be read because the Browser Bridge service is not registered.",
      success: false,
      values: {
        success: false,
        subaction: "refresh",
        error: "BROWSER_BRIDGE_SERVICE_UNAVAILABLE",
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "refresh",
        status,
        settings,
        companions,
      },
    };
  }
  settings = await service.getBrowserSettings();
  companions = (await service.listBrowserCompanions()).slice(0, 25);
  const connected = companions.length > 0;
  const text = [
    "Refreshed Agent Browser Bridge settings.",
    `Tracking: ${settings.trackingMode}.`,
    `Browser control: ${settings.allowBrowserControl ? "on" : "off"}.`,
    connected
      ? `Companions: ${companions.length} paired.`
      : "Companions: none paired.",
  ].join(" ");
  return {
    text,
    success: true,
    values: {
      success: true,
      subaction: "refresh",
      connected,
      trackingMode: settings.trackingMode,
      allowBrowserControl: settings.allowBrowserControl,
      companionCount: companions.length,
    },
    data: {
      actionName: ACTION_NAME,
      subaction: "refresh",
      status,
      settings,
      companions,
    },
  };
}

export const manageBrowserBridgeAction: Action = {
  name: ACTION_NAME,
  contexts: ["browser", "files", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "files", "connectors", "settings"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    // Install / setup synonyms
    "INSTALL_BROWSER_BRIDGE",
    "SETUP_BROWSER_BRIDGE",
    "PAIR_BROWSER",
    "CONNECT_BROWSER",
    "ADD_BROWSER_EXTENSION",
    // Reveal folder synonyms
    "REVEAL_BROWSER_BRIDGE_FOLDER",
    "OPEN_BROWSER_BRIDGE_FOLDER",
    "SHOW_BROWSER_EXTENSION_FOLDER",
    // Open manager synonyms
    "OPEN_CHROME_EXTENSIONS",
    "OPEN_BROWSER_BRIDGE_MANAGER",
    "OPEN_EXTENSION_MANAGER",
    // Refresh synonyms
    "REFRESH_BROWSER_BRIDGE",
    "REFRESH_BROWSER_BRIDGE_CONNECTION",
    "RELOAD_BROWSER_BRIDGE_STATUS",
    "RECONNECT_BROWSER",
    // Generic
    "MANAGE_CHROME_EXTENSION",
    "MANAGE_SAFARI_EXTENSION",
    "BROWSER_BRIDGE_INSTALL",
    "BROWSER_BRIDGE_REVEAL_FOLDER",
    "BROWSER_BRIDGE_OPEN_MANAGER",
    "BROWSER_BRIDGE_REFRESH",
  ],
  description:
    "Owner-only management of the Agent Browser Bridge companion extension that connects Eliza to the user's Chrome and Safari browsers. Subactions: refresh (show settings/status/connection state), install (build and reveal the extension for setup), reveal_folder (open the built extension folder), open_manager (open chrome://extensions only when the owner explicitly asks). The subaction parameter is inferred from message text when omitted; show/settings/status maps to refresh and 'open chrome extensions' maps to open_manager. Prefer the browser-bridge provider for passive companion status and use this action's refresh subaction only for an explicit live refresh.",
  descriptionCompressed:
    "Manage LifeOps Browser Bridge: refresh shows settings/status; install setup; reveal_folder build folder; open_manager chrome://extensions.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    return hasSelectedContext(state) || hasBrowserBridgeIntent(message, state);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as { parameters?: ManageBrowserBridgeParameters })
      ?.parameters;
    const subaction =
      normalizeSubaction(params?.subaction) ??
      inferSubactionFromMessage(
        typeof message.content?.text === "string" ? message.content.text : "",
      );
    try {
      switch (subaction) {
        case "install":
          return await runInstall();
        case "reveal_folder":
          return await runRevealFolder();
        case "open_manager":
          return await runOpenManager();
        case "refresh":
          return await runRefresh(runtime);
        default: {
          const exhaustive: never = subaction;
          throw new Error(`Unsupported MANAGE_BROWSER_BRIDGE subaction: ${exhaustive}`);
        }
      }
    } catch (err) {
      const text =
        `Failed MANAGE_BROWSER_BRIDGE ${subaction}: ${describeError(err)}`.slice(
          0,
          MAX_BROWSER_BRIDGE_TEXT_LENGTH,
        );
      logger.warn(`[${ACTION_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: {
          success: false,
          subaction,
          error: `MANAGE_BROWSER_BRIDGE_${subaction.toUpperCase()}_FAILED`,
        },
        data: { actionName: ACTION_NAME, subaction },
      };
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Bridge management op. Use refresh for show/settings/status/connection-state requests. Use open_manager only for explicit chrome://extensions or extension-manager requests. install builds/reveals/opens setup; reveal_folder opens the build folder. Inferred from message text if omitted.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...BROWSER_BRIDGE_SUBACTIONS],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show the browser bridge status.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Refreshing the browser bridge status.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought:
            "Show/status request maps to MANAGE_BROWSER_BRIDGE subaction=refresh.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Install the agent browser bridge extension.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Building and revealing the bridge extension.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought:
            "Setup intent maps to MANAGE_BROWSER_BRIDGE subaction=install.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Open chrome://extensions for me.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opening the extension manager.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought:
            "Explicit chrome://extensions request maps to MANAGE_BROWSER_BRIDGE subaction=open_manager.",
        },
      },
    ],
  ],
};
