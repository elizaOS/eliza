/**
 * Rigid, deterministic, multilingual view-command matcher — the fast shortcut.
 *
 * Lives in @elizaos/shared so BOTH the dedicated-runtime plugin
 * (plugin-app-control, which re-exports this module) and the container-free
 * SHARED-tier cloud runtime (packages/cloud shared-runtime turn) resolve
 * navigation intents from the SAME source — a Tier-0 shared agent boots zero
 * plugins, so it cannot reach plugin-app-control's VIEWS action and previously
 * answered "go to settings" with a hallucinated prose refusal (#F5-ACTIONS).
 *
 * This is the zero-model fast path for view switching: it recognises the
 * obvious, explicit navigation phrasings ("open settings", "go to the settings
 * view", "show me my calendar", "abre ajustes", "설정 열기", "打开设置",
 * "カレンダーを開いて", …) for every user-facing view, in every supported
 * language, in sub-millisecond time and with NO LLM call.
 *
 * It is consumed by:
 *   - the EARLY hook (navigate the instant a message arrives, before the reply),
 *   - the VIEWS action (deterministic target resolution),
 *   - the contextual evaluator's gate (defer rigid commands to the action),
 *   - the shared-runtime turn (emit a VIEWS navigation handoff for Tier-0 agents).
 *
 * Precision over recall: a noun alone never matches — there must be an explicit
 * nav signal (a navigation verb, a possessive, a "view/page/screen" word, or the
 * whole message being just the noun). Contextual/implicit intent ("fix the login
 * bug" → task-coordinator) is intentionally NOT handled here; that is the small-
 * model contextual evaluator's job.
 *
 * Languages: en, es, pt, fr, de, zh-CN, ja, ko, vi, tl (a superset of the
 * supported UI languages). Extend by adding nouns to VIEW_NOUNS and verbs/
 * possessives/view-words to the shared lists — the regexes recompile from data.
 */

import { DOCUMENTS_NAV_VOCABULARY } from "./shared-nav-targets.js";

// Navigation verbs across languages (lower-cased; CJK has no case).
const NAV_VERBS = [
  // en
  "open",
  "go",
  "go to",
  "goto",
  "show me",
  "show",
  "take me to",
  "navigate to",
  "switch to",
  "bring up",
  "pull up",
  "jump to",
  "head to",
  "get me to",
  "send me to",
  "let's go to",
  "lets go to",
  "change to",
  "view",
  "see",
  "display",
  "launch",
  "back to",
  "return to",
  "return",
  // es
  "abre",
  "abrir",
  "ábreme",
  "abreme",
  "ir a",
  "ve a",
  "muéstrame",
  "muestrame",
  "muestra",
  "llévame a",
  "llevame a",
  "cambia a",
  "ver",
  // pt
  "abra",
  "vá para",
  "va para",
  "vai para",
  "mostra",
  "mostre",
  "me leva para",
  "me mostra",
  "muda para",
  // fr
  "ouvre",
  "ouvrir",
  "va à",
  "va a",
  "montre-moi",
  "montre moi",
  "montre",
  "amène-moi à",
  "affiche",
  "accède à",
  // de
  "öffne",
  "öffnen",
  "offne",
  "zeig mir",
  "zeige",
  "geh zu",
  "bring mich zu",
  "wechsle zu",
  // zh
  "打开",
  "打開",
  "显示",
  "顯示",
  "切换到",
  "切換到",
  "进入",
  "進入",
  "查看",
  "转到",
  "轉到",
  "跳转到",
  "去",
  // ja
  "開いて",
  "開く",
  "ひらいて",
  "表示して",
  "表示",
  "に移動",
  "に行って",
  "見せて",
  "みせて",
  // ko
  "열어",
  "열어줘",
  "열기",
  "보여줘",
  "보여줘요",
  "로 이동",
  "으로 이동",
  "가줘",
  "띄워",
  "띄워줘",
  // vi
  "mở",
  "đi tới",
  "đi đến",
  "chuyển sang",
  "xem",
  "hiển thị",
  "cho tôi xem",
  // tl
  "buksan",
  "pumunta sa",
  "ipakita",
  "ipakita mo",
  "dalhin mo ako sa",
] as const;

// Words that, adjacent to a noun, confirm it denotes a view ("settings page").
const VIEW_WORDS = [
  "view",
  "page",
  "screen",
  "tab",
  "panel",
  "section",
  "vista",
  "página",
  "pagina",
  "pantalla",
  "pestaña",
  "pestana",
  "sección",
  "seccion",
  "vue",
  "écran",
  "ecran",
  "onglet",
  "ansicht",
  "seite",
  "bildschirm",
  "视图",
  "視圖",
  "页面",
  "頁面",
  "屏幕",
  "界面",
  "标签",
  "標籤",
  "画面",
  "ページ",
  "ビュー",
  "タブ",
  "화면",
  "페이지",
  "뷰",
  "탭",
  "trang",
  "màn hình",
  "chế độ xem",
  "thẻ",
  "pahina",
] as const;

// Possessives across languages ("my settings").
const POSSESSIVES = [
  "my",
  "mi",
  "mis",
  "mon",
  "ma",
  "mes",
  "mein",
  "meine",
  "meinen",
  "minha",
  "meu",
  "meus",
  "minhas",
  "我的",
  "내",
  "제",
  "나의",
  "của tôi",
  "akin",
  "aking",
] as const;

// Per-view multilingual noun synonyms. Order = match priority.
const VIEW_NOUNS: Record<string, readonly string[]> = {
  vault: [
    "vault",
    "secret vault",
    "secrets vault",
    "credential vault",
    "credentials vault",
    "stored secrets",
    "stored credentials",
  ],
  transcripts: [
    "transcripts",
    "transcript",
    "recording",
    "recordings",
    "voice notes",
    "voice transcript",
    "voice transcripts",
    "voice recordings",
    "transcripciones",
    "grabaciones",
    "transcrições",
    "gravações",
    "transcriptions",
    "enregistrements",
    "transkripte",
    "aufnahmen",
    "转录",
    "录音",
    "文字起こし",
    "録音",
    "기록",
    "녹음",
    "bản ghi",
    "ghi âm",
  ],
  settings: [
    "settings",
    "setting",
    "preferences",
    "preference",
    "configuration",
    "config",
    "options",
    "ajustes",
    "configuración",
    "configuracion",
    "preferencias",
    "opciones",
    "configurações",
    "configuracoes",
    "definições",
    "definicoes",
    "paramètres",
    "parametres",
    "réglages",
    "reglages",
    "einstellungen",
    "设置",
    "設定",
    "設置",
    "환경설정",
    "설정",
    "cài đặt",
    "thiết lập",
    "tùy chọn",
    "tuy chon",
    "setting",
    "mga setting",
  ],
  background: [
    "background",
    "app background",
    "page background",
    "wallpaper",
    "wallpapers",
    "backdrop",
    "theme background",
    "shader",
    "background image",
    "fond",
    "fond d'écran",
    "fond d'ecran",
    "wallpaper",
    "fondo",
    "papel tapiz",
    "壁纸",
    "壁紙",
    "背景",
    "背景画像",
    "배경",
    "appearance",
    "plano de fundo",
    "papier peint",
    "arrière-plan",
    "arriere-plan",
    "hintergrund",
    "hình nền",
    "hinh nen",
  ],
  calendar: [
    "calendar",
    "calender",
    "agenda",
    "schedule",
    "calendario",
    "calendário",
    "calendrier",
    "kalender",
    "日历",
    "日曆",
    "行事曆",
    "カレンダー",
    "予定表",
    "캘린더",
    "일정",
    "lịch",
    "lich",
    "lịch trình",
  ],
  inbox: [
    "inbox",
    "messages",
    "message",
    "mailbox",
    "mail",
    "email",
    "e-mail",
    "emails",
    "bandeja de entrada",
    "correo",
    "mensajes",
    "mensagens",
    "caixa de entrada",
    "boîte de réception",
    "boite de reception",
    "courrier",
    "posteingang",
    "收件箱",
    "邮件",
    "郵件",
    "消息",
    "訊息",
    "受信トレイ",
    "メール",
    "メッセージ",
    "받은편지함",
    "메일",
    "메시지",
    "hộp thư",
    "hop thu",
    "tin nhắn",
    "thư",
  ],
  wallet: [
    "wallet",
    "balance",
    "portfolio",
    "crypto",
    "funds",
    "tokens",
    "holdings",
    "cartera",
    "billetera",
    "saldo",
    "monedero",
    "carteira",
    "portefeuille",
    "brieftasche",
    "geldbörse",
    "geldborse",
    "钱包",
    "錢包",
    "余额",
    "餘額",
    "ウォレット",
    "財布",
    "残高",
    "지갑",
    "잔액",
    "ví",
    "số dư",
    "so du",
    "pitaka",
  ],
  finances: [
    "finances",
    "finance",
    "spending",
    "budget",
    "expenses",
    "transactions",
    "subscriptions",
    "finanzas",
    "gastos",
    "presupuesto",
    "finanças",
    "financas",
    "despesas",
    "dépenses",
    "depenses",
    "finanzen",
    "ausgaben",
    "财务",
    "財務",
    "财政",
    "开销",
    "花费",
    "支出",
    "家計",
    "재정",
    "지출",
    "가계부",
    "tài chính",
    "tai chinh",
    "chi tiêu",
    "ngân sách",
  ],
  focus: [
    "focus",
    "focus mode",
    "deep work",
    "concentration",
    "distractions",
    "enfoque",
    "concentración",
    "concentracion",
    "modo enfoque",
    "foco",
    "concentração",
    "concentracao",
    "mode concentration",
    "fokus",
    "konzentration",
    "专注",
    "专注模式",
    "集中",
    "집중",
    "집중 모드",
    "tập trung",
    "tap trung",
    "chế độ tập trung",
  ],
  goals: [
    "goals",
    "goal",
    "routines",
    "habits",
    "reminders",
    "alarms",
    "metas",
    "objetivos",
    "rutinas",
    "hábitos",
    "habitos",
    "rotinas",
    "objectifs",
    "routines",
    "ziele",
    "gewohnheiten",
    "目标",
    "目標",
    "习惯",
    "習慣",
    "목표",
    "습관",
    "mục tiêu",
    "muc tieu",
    "thói quen",
  ],
  health: [
    "health",
    "sleep",
    "fitness",
    "activity",
    "steps",
    "workouts",
    "workout",
    "salud",
    "sueño",
    "sueno",
    "actividad",
    "saúde",
    "saude",
    "sono",
    "atividade",
    "santé",
    "sante",
    "sommeil",
    "gesundheit",
    "schlaf",
    "健康",
    "睡眠",
    "健康状态",
    "수면",
    "건강",
    "sức khỏe",
    "suc khoe",
    "giấc ngủ",
  ],
  todos: [
    "todos",
    "to-dos",
    "to do",
    "to-do",
    "todo",
    "tasks",
    "task list",
    "checklist",
    "tareas",
    "pendientes",
    "lista de tareas",
    "tarefas",
    "afazeres",
    "tâches",
    "taches",
    "aufgaben",
    "待办",
    "待辦",
    "任务",
    "タスク",
    "やること",
    "할 일",
    "할일",
    "작업",
    "việc cần làm",
    "viec can lam",
    "công việc",
  ],
  notes: [
    "notes",
    "note",
    "notepad",
    "sticky notes",
    "scratchpad",
    "memo",
    "memos",
    "笔记",
    "メモ",
    "ノート",
    "메모",
    "노트",
    "ghi chú",
    "ghi chu",
  ],
  documents: [
    "documents",
    "document",
    ...Object.values(DOCUMENTS_NAV_VOCABULARY.localizedLabels),
    ...DOCUMENTS_NAV_VOCABULARY.aliases,
    "files",
    "file",
    "docs",
    "papers",
    "documentos",
    "archivos",
    "arquivos",
    "documents",
    "fichiers",
    "dokumente",
    "dateien",
    "文档",
    "文檔",
    "文件",
    "文書",
    "ファイル",
    "문서",
    "파일",
    "tài liệu",
    "tai lieu",
    "tập tin",
  ],
  memories: [
    "memories",
    "memory",
    "remembered",
    "recollections",
    "memoria",
    "memorias",
    "memória",
    "memórias",
    "mémoire",
    "souvenirs",
    "erinnerungen",
    "speicher",
    "记忆",
    "回忆",
    "記憶",
    "メモリ",
    "메모리",
    "기억",
    "ký ức",
    "ky uc",
    "bộ nhớ",
  ],
  relationships: [
    "relationships",
    "relationship",
    "contacts",
    "people",
    "network",
    "rolodex",
    "address book",
    "relaciones",
    "contactos",
    "gente",
    "relacionamentos",
    "contatos",
    "relations",
    "beziehungen",
    "kontakte",
    "关系",
    "關係",
    "联系人",
    "聯絡人",
    "人脉",
    "連絡先",
    "人脈",
    "관계",
    "연락처",
    "인맥",
    "mối quan hệ",
    "moi quan he",
    "danh bạ",
    "liên hệ",
  ],
  chat: [
    "home",
    "home screen",
    "home page",
    "home dashboard",
    "dashboard",
    "main screen",
    "main page",
    "main chat",
    "start screen",
    "landing page",
    "chat",
    "conversation",
    "chatear",
    "conversación",
    "conversacion",
    "conversa",
    "unterhaltung",
    "聊天",
    "对话",
    "對話",
    "チャット",
    "会話",
    "채팅",
    "대화",
    "trò chuyện",
    "tro chuyen",
  ],
  cockpit: [
    "cockpit",
    "coding cockpit",
    "the cockpit",
    "agents view",
    "my agents",
  ],
  "task-coordinator": [
    "task coordinator",
    "orchestrator",
    "coding view",
    "app builder",
    "coordinador de tareas",
    "orquestador",
    "coordenador de tarefas",
    "编码",
    "編碼",
    "코딩",
    "lập trình",
  ],
  help: [
    "help",
    "support",
    "faq",
    "ayuda",
    "soporte",
    "ajuda",
    "aide",
    "hilfe",
    "帮助",
    "幫助",
    "支持",
    "ヘルプ",
    "도움말",
    "trợ giúp",
    "tro giup",
    "giúp đỡ",
    "tulong",
  ],
  character: [
    "character",
    "personality",
    "identity",
    "persona",
    "personaje",
    "personalidad",
    "personagem",
    "personnage",
    "charakter",
    "角色",
    "个性",
    "個性",
    "キャラクター",
    "性格",
    "캐릭터",
    "성격",
    "nhân vật",
    "nhan vat",
    "tính cách",
  ],
  automations: [
    "automations",
    "automation",
    "workflows",
    "workflow",
    "triggers",
    "automatizaciones",
    "flujos",
    "automações",
    "automacoes",
    "automatisations",
    "automatisierung",
    "自动化",
    "自動化",
    "工作流",
    "ワークフロー",
    "自動化",
    "자동화",
    "워크플로",
    "tự động hóa",
    "tu dong hoa",
    "quy trình",
  ],
  // Generic app nouns belong to the local installed/running Apps surface and
  // named app-launch requests; only cloud-specific language can open this studio.
  "cloud-apps": [
    "cloud apps",
    "cloud app",
    "cloud applications",
    "eliza cloud apps",
    "apps studio",
    "app studio",
    "application studio",
    "published apps",
    "deployed apps",
    "app deployments",
    "aplicaciones en la nube",
    "estudio de aplicaciones",
    "aplicações na nuvem",
    "aplicacoes na nuvem",
    "aplicativos na nuvem",
    "estúdio de aplicativos",
    "estudio de aplicativos",
    "applications cloud",
    "studio d'applications",
    "cloud-apps",
    "anwendungsstudio",
    "cloud-anwendungen",
    "云应用",
    "云端应用",
    "雲端應用",
    "应用工作室",
    "應用工作室",
    "クラウドアプリ",
    "アプリスタジオ",
    "클라우드 앱",
    "앱 스튜디오",
    "ứng dụng đám mây",
    "ung dung dam may",
  ],
  "plugins-page": [
    "plugins",
    "plugin",
    "extensions",
    "add-ons",
    "addons",
    "complementos",
    "extensiones",
    "extensões",
    "extensoes",
    "erweiterungen",
    "插件",
    "扩展",
    "擴展",
    "プラグイン",
    "拡張",
    "플러그인",
    "확장",
    "tiện ích",
    "tien ich",
    "phần mở rộng",
  ],
  camera: [
    "camera",
    "photo",
    "capture",
    "cámara",
    "camara",
    "foto",
    "câmera",
    "camera",
    "caméra",
    "kamera",
    "相机",
    "相機",
    "摄像头",
    "カメラ",
    "카메라",
    "máy ảnh",
    "may anh",
  ],
  browser: [
    "browser",
    "web browser",
    "internet browser",
    "navegador",
    "navegador web",
    "navigateur",
    "navigateur web",
    "internetbrowser",
    "浏览器",
    "瀏覽器",
    "ブラウザ",
    "웹 브라우저",
    "브라우저",
    "trình duyệt",
    "trinh duyet",
  ],
};

// Priority order: more-specific / multiword views before generic ones so
// "task coordinator" wins over a bare "coding" elsewhere, etc.
const VIEW_PRIORITY = [
  "cockpit",
  "task-coordinator",
  "finances",
  "relationships",
  "automations",
  "documents",
  "memories",
  "transcripts",
  "vault",
  "settings",
  "background",
  "calendar",
  "inbox",
  "wallet",
  "focus",
  "goals",
  "health",
  "todos",
  "notes",
  "character",
  "plugins-page",
  "cloud-apps",
  "browser",
  "camera",
  "help",
  "chat",
];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LATIN_SCRIPT = /\p{Script=Latin}/u;
const CJK_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isLatinPhrase(phrase: string): boolean {
  return LATIN_SCRIPT.test(phrase) && !CJK_SCRIPT.test(phrase);
}

function rawAlt(items: readonly string[]): string {
  return [...new Set(items)]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join("|");
}

// Sort alternation members longest-first so multiword phrases match before
// their prefixes. Latin-script boundaries keep labels and nav verbs from
// matching inside unrelated words while CJK remains compatible with particles.
function alt(items: readonly string[]): string {
  const sorted = [...new Set(items)].sort((a, b) => b.length - a.length);
  const latin = sorted.filter(isLatinPhrase);
  const unbounded = sorted.filter((phrase) => !isLatinPhrase(phrase));
  const groups = [
    latin.length
      ? `(?<![\\p{L}\\p{N}])(?:${rawAlt(latin)})(?![\\p{L}\\p{N}])`
      : "",
    unbounded.length ? `(?:${rawAlt(unbounded)})` : "",
  ].filter(Boolean);
  return groups.length === 1 ? groups[0] : `(?:${groups.join("|")})`;
}

const CJK_NOUN_BOUNDARIES = [
  {
    script: "Han",
    endsWith: /\p{Script=Han}$/u,
    startsWith: /^\p{Script=Han}/u,
    particles: [],
  },
  {
    script: "Hiragana",
    endsWith: /\p{Script=Hiragana}$/u,
    startsWith: /^\p{Script=Hiragana}/u,
    particles: ["から", "まで", "を", "へ", "に", "の", "は", "が"],
  },
  {
    script: "Katakana",
    endsWith: /\p{Script=Katakana}$/u,
    startsWith: /^\p{Script=Katakana}/u,
    particles: [],
  },
  {
    script: "Hangul",
    endsWith: /\p{Script=Hangul}$/u,
    startsWith: /^\p{Script=Hangul}/u,
    particles: ["으로", "은", "는", "이", "가", "을", "를", "로"],
  },
] as const;

function nounAlt(items: readonly string[]): string {
  const remaining = new Set(items);
  const groups: string[] = [];
  const latin = [...remaining].filter(isLatinPhrase);
  for (const phrase of latin) remaining.delete(phrase);
  if (latin.length) {
    groups.push(`(?<![\\p{L}\\p{N}])(?:${rawAlt(latin)})(?![\\p{L}\\p{N}])`);
  }

  for (const boundary of CJK_NOUN_BOUNDARIES) {
    const phrases = [...remaining].filter((phrase) =>
      boundary.endsWith.test(phrase),
    );
    for (const phrase of phrases) remaining.delete(phrase);
    if (!phrases.length) continue;
    const viewWords = VIEW_WORDS.filter((word) =>
      boundary.startsWith.test(word),
    );
    const terminal = [
      ...(viewWords.length ? [`(?:${rawAlt(viewWords)})`] : []),
      `[^\\p{Script=${boundary.script}}]`,
      "$",
    ].join("|");
    const particles = boundary.particles.length
      ? `(?:${rawAlt(boundary.particles)})?`
      : "";
    groups.push(`(?:${rawAlt(phrases)})(?=${particles}(?:${terminal}))`);
  }

  if (remaining.size) groups.push(`(?:${rawAlt([...remaining])})`);
  return groups.length === 1 ? groups[0] : `(?:${groups.join("|")})`;
}

const VERB_ALT = alt(NAV_VERBS);
const VW_ALT = alt(VIEW_WORDS);
const POSS_ALT = alt(POSSESSIVES);
const NAVIGATION_NEGATIONS = [
  // en
  "do not",
  "don't",
  "don’t",
  "dont",
  "never",
  "not",
  "no",
  // es / pt
  "nunca",
  "não",
  "nao",
  // fr
  "ne",
  "pas",
  "jamais",
  // de
  "nicht",
  "nie",
  "niemals",
  // zh
  "不要",
  "不用",
  "别",
  "別",
  "勿",
  // vi / tl
  "đừng",
  "không",
  "khong",
  "huwag",
] as const;
const NEGATION_ALT = alt(NAVIGATION_NEGATIONS);
const SAME_CLAUSE_GAP = "[^.!?;\\n]";
const NEGATED_NAVIGATION_RE = new RegExp(
  `(?:${NEGATION_ALT}|(?<![\\p{L}\\p{N}])n['’])${SAME_CLAUSE_GAP}{0,48}?(?:${VERB_ALT})|(?:${VERB_ALT})${SAME_CLAUSE_GAP}{0,24}?(?:${NEGATION_ALT})`,
  "iu",
);
const CLOUD_APPS_VIEW_ID = "cloud-apps";
const CLOUD_APPS_STRONG_NAV_VERBS = [
  // en
  "open",
  "go to",
  "goto",
  "take me to",
  "navigate to",
  "switch to",
  "bring up",
  "pull up",
  "jump to",
  "head to",
  "get me to",
  "send me to",
  "let's go to",
  "lets go to",
  "change to",
  "launch",
  "back to",
  "return to",
  // es
  "abre",
  "abrir",
  "ábreme",
  "abreme",
  "ir a",
  "ve a",
  "llévame a",
  "llevame a",
  "cambia a",
  // pt
  "abra",
  "vá para",
  "va para",
  "vai para",
  "me leva para",
  "muda para",
  // fr
  "ouvre",
  "ouvrir",
  "va à",
  "va a",
  "amène-moi à",
  "accède à",
  // de
  "öffne",
  "öffnen",
  "offne",
  "geh zu",
  "bring mich zu",
  "wechsle zu",
  // zh
  "打开",
  "打開",
  "切换到",
  "切換到",
  "进入",
  "進入",
  "转到",
  "轉到",
  "跳转到",
  "去",
  // ja
  "開いて",
  "開く",
  "ひらいて",
  "に移動",
  "に行って",
  // ko
  "열어",
  "열어줘",
  "열기",
  "로 이동",
  "으로 이동",
  "가줘",
  // vi
  "mở",
  "đi tới",
  "đi đến",
  "chuyển sang",
  // tl
  "buksan",
  "pumunta sa",
  "dalhin mo ako sa",
] as const;
const CLOUD_APPS_ARTICLES = [
  "the",
  "my",
  "las",
  "mis",
  "os",
  "meus",
  "les",
  "mes",
  "die",
  "meine",
  "ang",
] as const;
const CLOUD_APPS_PARTICLES = [
  "を",
  "へ",
  "に",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "로",
  "으로",
] as const;
const CLOUD_APPS_COURTESY = [
  "please",
  "por favor",
  "s'il vous plaît",
  "s il vous plait",
  "bitte",
] as const;
const CLOUD_APPS_NOUNS = VIEW_NOUNS[CLOUD_APPS_VIEW_ID].filter(
  // A singular cloud app takes an app name ("open the cloud app Acme") and is
  // an APP/domain request, never a request for the inventory studio.
  (noun) => noun !== "cloud app",
);
const CLOUD_APPS_VERB_ALT = alt(CLOUD_APPS_STRONG_NAV_VERBS);
const CLOUD_APPS_NOUN_ALT = nounAlt(CLOUD_APPS_NOUNS);
const CLOUD_APPS_MENTION_RE = new RegExp(
  nounAlt(VIEW_NOUNS[CLOUD_APPS_VIEW_ID]),
  "iu",
);
const CLOUD_APPS_ARTICLE_ALT = alt(CLOUD_APPS_ARTICLES);
const CLOUD_APPS_PARTICLE_ALT = rawAlt(CLOUD_APPS_PARTICLES);
const CLOUD_APPS_COURTESY_ALT = alt(CLOUD_APPS_COURTESY);
const CLOUD_APPS_EDGE = `[\\s\\p{P}]*`;
const CLOUD_APPS_OPTIONAL_COURTESY = `(?:(?:${CLOUD_APPS_COURTESY_ALT})[\\s\\p{P}]+)?`;
const CLOUD_APPS_OPTIONAL_ARTICLE = `(?:(?:${CLOUD_APPS_ARTICLE_ALT})[\\s\\p{P}]+)?`;
const CLOUD_APPS_OPTIONAL_PARTICLE = `(?:${CLOUD_APPS_PARTICLE_ALT})?`;
const CLOUD_APPS_COMMAND_RE = new RegExp(
  [
    `^${CLOUD_APPS_EDGE}${CLOUD_APPS_OPTIONAL_COURTESY}(?:${CLOUD_APPS_VERB_ALT})[\\s\\p{P}]*${CLOUD_APPS_OPTIONAL_ARTICLE}(?:${CLOUD_APPS_NOUN_ALT})${CLOUD_APPS_EDGE}(?:(?:${CLOUD_APPS_COURTESY_ALT})${CLOUD_APPS_EDGE})?$`,
    `^${CLOUD_APPS_EDGE}${CLOUD_APPS_OPTIONAL_COURTESY}(?:${CLOUD_APPS_NOUN_ALT})${CLOUD_APPS_OPTIONAL_PARTICLE}[\\s\\p{P}]*(?:${CLOUD_APPS_VERB_ALT})${CLOUD_APPS_EDGE}(?:(?:${CLOUD_APPS_COURTESY_ALT})${CLOUD_APPS_EDGE})?$`,
  ].join("|"),
  "iu",
);
const COMPANION_ACTION_VERBS = new Set([
  "DRAW",
  "GENERATE",
  "MAKE",
  "PERFORM",
  "PLAY",
  "RENDER",
  "RUN",
  "TRIGGER",
]);
const COMPANION_ACTION_TARGETS = new Set([
  "ANIMATION",
  "AVATAR",
  "COMPANION",
  "DANCE",
  "EMOTE",
  "GESTURE",
  "POSE",
  "WAVE",
]);

interface CompiledView {
  viewId: string;
  re: RegExp;
}

// For each view, compile one regex covering the precise nav patterns:
//   verb … noun           (open settings / 打开设置 / abre ajustes)
//   noun … verb           (SOV: 설정 열기 / 設定を開いて)
//   possessive noun       (my settings / 我的设置 / mis ajustes)
//   noun viewword         (settings page / 设置页面)
//   whole message == noun (just "settings")
// Gaps use [\s\S]{0,N} so CJK (no spaces) and short filler both match, while
// staying tight enough to avoid cross-clause false positives.
const COMPILED: CompiledView[] = VIEW_PRIORITY.filter(
  (v) => v !== CLOUD_APPS_VIEW_ID && VIEW_NOUNS[v],
).map((viewId) => {
  const N = nounAlt(VIEW_NOUNS[viewId]);
  const pattern = [
    `(?:${VERB_ALT})[\\s\\S]{0,16}?(?:${N})`,
    `(?:${N})[\\s\\S]{0,8}?(?:${VERB_ALT})`,
    `(?:${POSS_ALT})[\\s\\S]{0,4}?(?:${N})`,
    `(?:${N})[\\s\\S]{0,4}?(?:${VW_ALT})`,
    `^[\\s\\p{P}]*(?:${N})[\\s\\p{P}]*$`,
  ].join("|");
  return { viewId, re: new RegExp(pattern, "iu") };
});

// Bare "go back" is the conversational counterpart of the shell's Home affordance.
// Browser/OS history remains a client-owned gesture, so this exact whole-message
// form can safely return to the canonical chat surface without guessing history.
const BARE_HOME_NAVIGATION = /^[\s\p{P}]*go\s+back[\s\p{P}]*$/iu;

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Match an explicit, deterministic view-navigation command. Returns the view id
 * or null. No LLM. Precision-first: a bare noun never matches without a nav
 * signal (verb / possessive / view-word / whole-message).
 */
export function matchViewCommand(text: string | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 160) return null; // commands are short
  const lower = raw.toLowerCase();
  if (looksLikeCompanionActionRequest(lower)) return null;
  if (NEGATED_NAVIGATION_RE.test(lower)) return null;
  if (BARE_HOME_NAVIGATION.test(lower)) return "chat";
  const variants = [lower, stripDiacritics(lower)];
  if (variants.some((variant) => CLOUD_APPS_COMMAND_RE.test(variant))) {
    return CLOUD_APPS_VIEW_ID;
  }
  // A Cloud Apps phrase that is not the strict command above belongs to normal
  // action planning. Do not let another noun in the same sentence ("help",
  // "documentation") hijack it into an unrelated deterministic view.
  if (variants.some((variant) => CLOUD_APPS_MENTION_RE.test(variant)))
    return null;
  for (const { viewId, re } of COMPILED) {
    for (const v of variants) {
      if (re.test(v)) return viewId;
    }
  }
  return null;
}

function looksLikeCompanionActionRequest(text: string): boolean {
  const tokens = text.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return (
    tokens.some((token) => COMPANION_ACTION_VERBS.has(token)) &&
    tokens.some((token) => COMPANION_ACTION_TARGETS.has(token))
  );
}

/** All view ids this matcher can resolve (for tests + callers). */
export const MATCHER_VIEW_IDS = VIEW_PRIORITY.filter((v) => VIEW_NOUNS[v]);

/** Exposed for exhaustive test generation. */
export const __matcherData = { NAV_VERBS, VIEW_WORDS, POSSESSIVES, VIEW_NOUNS };
