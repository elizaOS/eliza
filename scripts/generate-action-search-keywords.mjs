#!/usr/bin/env node
/**
 * Generate multilingual action-search keyword metadata.
 *
 * This file intentionally produces retrieval metadata, not validation gates.
 * The source of truth for action inventory is the action availability audit;
 * the source of truth for supported languages is the shared i18n keyword
 * convention. Unknown product/protocol names are preserved as-is because users
 * usually say them untranslated.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUTPUT_FILE = "packages/shared/src/i18n/keywords/action-search.generated.keywords.json";
const CONTEXT_KEYWORD_FILE = "packages/shared/src/i18n/keywords/context-search.keywords.json";
const SUPPORTED_LOCALES = ["es", "ko", "pt", "tl", "vi", "zh-CN"];
const MAX_BASE_TERMS = 64;
const MAX_LOCALE_TERMS = 80;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "from",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "the",
  "this",
  "to",
  "up",
  "with",
  "you",
]);

const PHRASE_TRANSLATIONS = {
  es: {
    "agent inbox": ["buzon del agente", "correo del agente"],
    "ask user question": ["preguntar al usuario", "hacer una pregunta"],
    "book travel": ["reservar viaje", "reservar vuelo", "reservar hotel"],
    "check availability": ["comprobar disponibilidad", "ver disponibilidad"],
    "computer use": ["usar computadora", "controlar computadora"],
    "execute code": ["ejecutar codigo", "correr script"],
    "manage secret": ["gestionar secreto", "administrar clave"],
    "read attachment": ["leer adjunto", "abrir archivo adjunto"],
    "request secret": ["pedir secreto", "solicitar clave"],
    "set secret": ["guardar secreto", "configurar clave"],
    "web fetch": ["leer url", "obtener pagina web"],
  },
  ko: {
    "agent inbox": ["에이전트 받은편지함", "에이전트 메일함"],
    "ask user question": ["사용자에게 질문", "질문하기"],
    "book travel": ["여행 예약", "항공권 예약", "호텔 예약"],
    "check availability": ["가능 시간 확인", "일정 가능 여부 확인"],
    "computer use": ["컴퓨터 사용", "컴퓨터 제어"],
    "execute code": ["코드 실행", "스크립트 실행"],
    "manage secret": ["비밀 관리", "키 관리"],
    "read attachment": ["첨부 파일 읽기", "첨부 열기"],
    "request secret": ["비밀 요청", "키 요청"],
    "set secret": ["비밀 저장", "키 설정"],
    "web fetch": ["url 읽기", "웹페이지 가져오기"],
  },
  pt: {
    "agent inbox": ["caixa de entrada do agente", "email do agente"],
    "ask user question": ["perguntar ao usuario", "fazer pergunta"],
    "book travel": ["reservar viagem", "reservar voo", "reservar hotel"],
    "check availability": ["verificar disponibilidade", "checar disponibilidade"],
    "computer use": ["usar computador", "controlar computador"],
    "execute code": ["executar codigo", "rodar script"],
    "manage secret": ["gerenciar segredo", "administrar chave"],
    "read attachment": ["ler anexo", "abrir anexo"],
    "request secret": ["pedir segredo", "solicitar chave"],
    "set secret": ["salvar segredo", "configurar chave"],
    "web fetch": ["ler url", "buscar pagina web"],
  },
  tl: {
    "agent inbox": ["inbox ng agent", "email ng agent"],
    "ask user question": ["magtanong sa user", "tanungin ang user"],
    "book travel": ["mag-book ng biyahe", "mag-book ng flight", "mag-book ng hotel"],
    "check availability": ["tingnan ang availability", "suriin ang schedule"],
    "computer use": ["gamitin ang computer", "kontrolin ang computer"],
    "execute code": ["patakbuhin ang code", "run script"],
    "manage secret": ["ayusin ang secret", "manage api key"],
    "read attachment": ["basahin ang attachment", "buksan ang kalakip"],
    "request secret": ["humingi ng secret", "humingi ng api key"],
    "set secret": ["i-save ang secret", "itakda ang api key"],
    "web fetch": ["basahin ang url", "kunin ang web page"],
  },
  vi: {
    "agent inbox": ["hop thu tac tu", "email tac tu"],
    "ask user question": ["hoi nguoi dung", "dat cau hoi"],
    "book travel": ["dat chuyen di", "dat ve may bay", "dat khach san"],
    "check availability": ["kiem tra lich ranh", "kiem tra kha dung"],
    "computer use": ["dung may tinh", "dieu khien may tinh"],
    "execute code": ["chay ma", "chay script"],
    "manage secret": ["quan ly bi mat", "quan ly khoa"],
    "read attachment": ["doc tep dinh kem", "mo tep dinh kem"],
    "request secret": ["yeu cau bi mat", "yeu cau khoa"],
    "set secret": ["luu bi mat", "dat khoa"],
    "web fetch": ["doc url", "lay trang web"],
  },
  "zh-CN": {
    "agent inbox": ["代理收件箱", "代理邮箱"],
    "ask user question": ["询问用户", "提问用户"],
    "book travel": ["预订旅行", "预订航班", "预订酒店"],
    "check availability": ["检查可用时间", "查看空闲时间"],
    "computer use": ["使用电脑", "控制电脑"],
    "execute code": ["执行代码", "运行脚本"],
    "manage secret": ["管理密钥", "管理凭据"],
    "read attachment": ["读取附件", "打开附件"],
    "request secret": ["请求密钥", "索要凭据"],
    "set secret": ["保存密钥", "设置凭据"],
    "web fetch": ["读取网址", "获取网页"],
  },
};

const TOKEN_TRANSLATIONS = {
  es: {
    account: ["cuenta"],
    activity: ["actividad"],
    add: ["agregar", "anadir"],
    admin: ["administrador"],
    agent: ["agente"],
    analyze: ["analizar"],
    app: ["app", "aplicacion"],
    ask: ["preguntar"],
    attachment: ["adjunto", "archivo adjunto"],
    audio: ["audio"],
    automation: ["automatizacion"],
    availability: ["disponibilidad"],
    bash: ["bash", "terminal"],
    book: ["reservar"],
    browser: ["navegador"],
    calendar: ["calendario"],
    call: ["llamada", "llamar"],
    character: ["personaje", "personalidad"],
    check: ["comprobar", "verificar"],
    code: ["codigo"],
    comment: ["comentario"],
    complete: ["completar", "terminar"],
    computer: ["computadora", "ordenador"],
    config: ["configuracion"],
    configure: ["configurar"],
    connector: ["conector", "integracion"],
    contact: ["contacto"],
    create: ["crear", "nuevo"],
    credential: ["credencial"],
    crypto: ["cripto"],
    data: ["datos"],
    database: ["base de datos"],
    delete: ["eliminar", "borrar"],
    desktop: ["escritorio"],
    document: ["documento"],
    download: ["descargar"],
    draft: ["borrador"],
    edit: ["editar", "modificar"],
    email: ["correo", "email"],
    execute: ["ejecutar", "correr"],
    fetch: ["obtener", "traer"],
    file: ["archivo"],
    finance: ["finanzas"],
    find: ["buscar", "encontrar"],
    follow: ["seguir"],
    form: ["formulario"],
    game: ["juego"],
    generate: ["generar"],
    get: ["obtener", "ver"],
    health: ["salud"],
    image: ["imagen", "foto"],
    inbox: ["buzon", "bandeja de entrada"],
    install: ["instalar"],
    issue: ["issue", "ticket", "tarea"],
    key: ["clave"],
    knowledge: ["conocimiento"],
    list: ["listar", "mostrar"],
    log: ["registro", "log"],
    manage: ["gestionar", "administrar"],
    media: ["multimedia"],
    memory: ["memoria"],
    message: ["mensaje"],
    music: ["musica"],
    mute: ["silenciar"],
    open: ["abrir"],
    page: ["pagina"],
    password: ["contrasena"],
    payment: ["pago"],
    phone: ["telefono"],
    plan: ["plan"],
    play: ["reproducir"],
    plugin: ["plugin", "complemento"],
    post: ["publicar", "post"],
    profile: ["perfil"],
    question: ["pregunta"],
    read: ["leer"],
    reminder: ["recordatorio"],
    remove: ["quitar", "eliminar"],
    reply: ["responder"],
    request: ["solicitar", "pedir"],
    role: ["rol", "permiso"],
    room: ["sala", "chat"],
    route: ["enrutar", "ruta"],
    runtime: ["runtime", "estado"],
    save: ["guardar"],
    schedule: ["programar", "calendario"],
    search: ["buscar"],
    secret: ["secreto", "clave", "credencial"],
    send: ["enviar", "mandar"],
    setting: ["ajuste", "configuracion"],
    setup: ["configurar"],
    skill: ["habilidad", "skill"],
    social: ["social"],
    state: ["estado"],
    stream: ["transmision", "stream"],
    task: ["tarea"],
    terminal: ["terminal"],
    todo: ["pendiente", "tarea"],
    token: ["token"],
    transfer: ["transferir"],
    travel: ["viaje"],
    trust: ["confianza"],
    update: ["actualizar"],
    user: ["usuario"],
    video: ["video"],
    vision: ["vision"],
    wallet: ["billetera", "wallet"],
    web: ["web", "internet"],
    workflow: ["flujo de trabajo"],
    world: ["mundo"],
    write: ["escribir"],
    zone: ["zona"],
  },
  ko: {
    account: ["계정"],
    activity: ["활동"],
    add: ["추가"],
    admin: ["관리자"],
    agent: ["에이전트"],
    analyze: ["분석"],
    app: ["앱", "애플리케이션"],
    ask: ["질문"],
    attachment: ["첨부", "첨부 파일"],
    audio: ["오디오"],
    automation: ["자동화"],
    availability: ["가능 시간", "가용성"],
    bash: ["배시", "터미널"],
    book: ["예약"],
    browser: ["브라우저"],
    calendar: ["캘린더", "일정"],
    call: ["전화", "통화"],
    character: ["캐릭터", "성격"],
    check: ["확인"],
    code: ["코드"],
    comment: ["댓글", "코멘트"],
    complete: ["완료"],
    computer: ["컴퓨터"],
    config: ["설정"],
    configure: ["구성", "설정"],
    connector: ["커넥터", "통합"],
    contact: ["연락처"],
    create: ["생성", "만들기"],
    credential: ["자격 증명", "인증 정보"],
    crypto: ["암호화폐", "크립토"],
    data: ["데이터"],
    database: ["데이터베이스"],
    delete: ["삭제"],
    desktop: ["데스크톱"],
    document: ["문서"],
    download: ["다운로드"],
    draft: ["초안"],
    edit: ["편집", "수정"],
    email: ["이메일", "메일"],
    execute: ["실행"],
    fetch: ["가져오기"],
    file: ["파일"],
    finance: ["금융"],
    find: ["찾기", "검색"],
    follow: ["팔로우", "따르기"],
    form: ["폼", "양식"],
    game: ["게임"],
    generate: ["생성"],
    get: ["가져오기", "조회"],
    health: ["건강"],
    image: ["이미지", "사진"],
    inbox: ["받은편지함", "메일함"],
    install: ["설치"],
    issue: ["이슈", "티켓", "작업"],
    key: ["키"],
    knowledge: ["지식"],
    list: ["목록", "나열"],
    log: ["로그"],
    manage: ["관리"],
    media: ["미디어"],
    memory: ["기억", "메모리"],
    message: ["메시지"],
    music: ["음악"],
    mute: ["음소거"],
    open: ["열기"],
    page: ["페이지"],
    password: ["비밀번호"],
    payment: ["결제"],
    phone: ["전화"],
    plan: ["계획"],
    play: ["재생"],
    plugin: ["플러그인"],
    post: ["게시", "포스트"],
    profile: ["프로필"],
    question: ["질문"],
    read: ["읽기"],
    reminder: ["리마인더", "알림"],
    remove: ["제거", "삭제"],
    reply: ["답장", "응답"],
    request: ["요청"],
    role: ["역할", "권한"],
    room: ["방", "채팅방"],
    route: ["라우팅", "경로"],
    runtime: ["런타임", "실행 상태"],
    save: ["저장"],
    schedule: ["예약", "일정"],
    search: ["검색"],
    secret: ["비밀", "시크릿", "키"],
    send: ["보내기", "전송"],
    setting: ["설정"],
    setup: ["설정", "셋업"],
    skill: ["스킬", "기술"],
    social: ["소셜"],
    state: ["상태"],
    stream: ["스트림", "방송"],
    task: ["작업"],
    terminal: ["터미널"],
    todo: ["할 일", "작업"],
    token: ["토큰"],
    transfer: ["전송", "송금"],
    travel: ["여행"],
    trust: ["신뢰"],
    update: ["업데이트", "수정"],
    user: ["사용자"],
    video: ["비디오", "영상"],
    vision: ["비전", "시각"],
    wallet: ["지갑"],
    web: ["웹", "인터넷"],
    workflow: ["워크플로"],
    world: ["월드", "세계"],
    write: ["쓰기", "작성"],
    zone: ["구역", "존"],
  },
  pt: {
    account: ["conta"],
    activity: ["atividade"],
    add: ["adicionar"],
    admin: ["administrador"],
    agent: ["agente"],
    analyze: ["analisar"],
    app: ["app", "aplicativo"],
    ask: ["perguntar"],
    attachment: ["anexo"],
    audio: ["audio"],
    automation: ["automacao"],
    availability: ["disponibilidade"],
    bash: ["bash", "terminal"],
    book: ["reservar"],
    browser: ["navegador"],
    calendar: ["calendario"],
    call: ["ligacao", "chamada"],
    character: ["personagem", "personalidade"],
    check: ["verificar", "checar"],
    code: ["codigo"],
    comment: ["comentario"],
    complete: ["concluir", "completar"],
    computer: ["computador"],
    config: ["configuracao"],
    configure: ["configurar"],
    connector: ["conector", "integracao"],
    contact: ["contato"],
    create: ["criar", "novo"],
    credential: ["credencial"],
    crypto: ["cripto"],
    data: ["dados"],
    database: ["banco de dados"],
    delete: ["excluir", "apagar"],
    desktop: ["area de trabalho"],
    document: ["documento"],
    download: ["baixar", "download"],
    draft: ["rascunho"],
    edit: ["editar", "modificar"],
    email: ["email", "correio"],
    execute: ["executar", "rodar"],
    fetch: ["buscar", "obter"],
    file: ["arquivo"],
    finance: ["financas"],
    find: ["procurar", "encontrar"],
    follow: ["seguir"],
    form: ["formulario"],
    game: ["jogo"],
    generate: ["gerar"],
    get: ["obter", "ver"],
    health: ["saude"],
    image: ["imagem", "foto"],
    inbox: ["caixa de entrada"],
    install: ["instalar"],
    issue: ["issue", "ticket", "tarefa"],
    key: ["chave"],
    knowledge: ["conhecimento"],
    list: ["listar", "mostrar"],
    log: ["log", "registro"],
    manage: ["gerenciar", "administrar"],
    media: ["midia"],
    memory: ["memoria"],
    message: ["mensagem"],
    music: ["musica"],
    mute: ["silenciar"],
    open: ["abrir"],
    page: ["pagina"],
    password: ["senha"],
    payment: ["pagamento"],
    phone: ["telefone"],
    plan: ["plano"],
    play: ["tocar", "reproduzir"],
    plugin: ["plugin", "complemento"],
    post: ["postar", "publicar"],
    profile: ["perfil"],
    question: ["pergunta"],
    read: ["ler"],
    reminder: ["lembrete"],
    remove: ["remover", "excluir"],
    reply: ["responder"],
    request: ["solicitar", "pedir"],
    role: ["funcao", "permissao"],
    room: ["sala", "chat"],
    route: ["rotear", "rota"],
    runtime: ["runtime", "estado"],
    save: ["salvar", "guardar"],
    schedule: ["agendar", "calendario"],
    search: ["buscar", "pesquisar"],
    secret: ["segredo", "chave", "credencial"],
    send: ["enviar", "mandar"],
    setting: ["configuracao", "ajuste"],
    setup: ["configurar"],
    skill: ["habilidade", "skill"],
    social: ["social"],
    state: ["estado"],
    stream: ["stream", "transmissao"],
    task: ["tarefa"],
    terminal: ["terminal"],
    todo: ["afazer", "tarefa"],
    token: ["token"],
    transfer: ["transferir"],
    travel: ["viagem"],
    trust: ["confianca"],
    update: ["atualizar"],
    user: ["usuario"],
    video: ["video"],
    vision: ["visao"],
    wallet: ["carteira", "wallet"],
    web: ["web", "internet"],
    workflow: ["fluxo de trabalho"],
    world: ["mundo"],
    write: ["escrever"],
    zone: ["zona"],
  },
  tl: {
    account: ["account", "kuwenta"],
    activity: ["activity", "aktibidad"],
    add: ["dagdag", "idagdag"],
    admin: ["admin"],
    agent: ["agent"],
    analyze: ["suriin", "analyze"],
    app: ["app", "aplikasyon"],
    ask: ["tanong", "magtanong"],
    attachment: ["attachment", "kalakip"],
    audio: ["audio", "tunog"],
    automation: ["automation"],
    availability: ["availability", "bakanteng oras"],
    bash: ["bash", "terminal"],
    book: ["mag-book", "magpareserba"],
    browser: ["browser"],
    calendar: ["kalendaryo", "calendar"],
    call: ["tawag", "tumawag"],
    character: ["karakter", "personalidad"],
    check: ["tingnan", "suriin"],
    code: ["code"],
    comment: ["komento"],
    complete: ["tapusin", "kumpletuhin"],
    computer: ["computer"],
    config: ["config", "setting"],
    configure: ["i-configure", "ayusin"],
    connector: ["connector", "integration"],
    contact: ["contact", "kakilala"],
    create: ["gumawa", "lumikha"],
    credential: ["credential", "login"],
    crypto: ["crypto"],
    data: ["data"],
    database: ["database"],
    delete: ["burahin", "tanggalin"],
    desktop: ["desktop"],
    document: ["dokumento"],
    download: ["download", "i-download"],
    draft: ["draft"],
    edit: ["i-edit", "baguhin"],
    email: ["email", "koreo"],
    execute: ["patakbuhin", "execute"],
    fetch: ["kunin", "fetch"],
    file: ["file", "talaksan"],
    finance: ["finance", "pera"],
    find: ["hanapin", "maghanap"],
    follow: ["sundan", "follow"],
    form: ["form"],
    game: ["laro"],
    generate: ["gumawa", "generate"],
    get: ["kunin", "tingnan"],
    health: ["kalusugan"],
    image: ["larawan", "image"],
    inbox: ["inbox"],
    install: ["install", "i-install"],
    issue: ["issue", "ticket", "task"],
    key: ["key", "susi"],
    knowledge: ["kaalaman"],
    list: ["ilista", "ipakita"],
    log: ["log", "talaan"],
    manage: ["i-manage", "ayusin"],
    media: ["media"],
    memory: ["memory", "alaala"],
    message: ["mensahe"],
    music: ["musika"],
    mute: ["i-mute", "patahimikin"],
    open: ["buksan"],
    page: ["pahina", "page"],
    password: ["password"],
    payment: ["bayad", "payment"],
    phone: ["telepono"],
    plan: ["plano"],
    play: ["patugtugin", "i-play"],
    plugin: ["plugin"],
    post: ["post", "mag-post"],
    profile: ["profile"],
    question: ["tanong"],
    read: ["basahin"],
    reminder: ["paalala"],
    remove: ["tanggalin", "alisin"],
    reply: ["sagot", "tumugon"],
    request: ["humingi", "request"],
    role: ["role", "pahintulot"],
    room: ["room", "kwarto", "chat"],
    route: ["route", "ruta"],
    runtime: ["runtime", "estado"],
    save: ["i-save", "itago"],
    schedule: ["iskedyul"],
    search: ["hanapin", "mag-search"],
    secret: ["secret", "api key", "credential"],
    send: ["ipadala", "send"],
    setting: ["setting", "configuration"],
    setup: ["setup", "i-set up"],
    skill: ["skill", "kakayahan"],
    social: ["social"],
    state: ["estado", "state"],
    stream: ["stream", "broadcast"],
    task: ["task", "gawain"],
    terminal: ["terminal"],
    todo: ["todo", "gawain"],
    token: ["token"],
    transfer: ["ilipat", "transfer"],
    travel: ["biyahe", "travel"],
    trust: ["tiwala"],
    update: ["i-update", "baguhin"],
    user: ["user", "gumagamit"],
    video: ["video"],
    vision: ["vision", "tingin"],
    wallet: ["wallet", "pitaka"],
    web: ["web", "internet"],
    workflow: ["workflow"],
    world: ["world", "mundo"],
    write: ["isulat", "write"],
    zone: ["zone", "sona"],
  },
  vi: {
    account: ["tai khoan"],
    activity: ["hoat dong"],
    add: ["them"],
    admin: ["quan tri"],
    agent: ["tac tu", "agent"],
    analyze: ["phan tich"],
    app: ["ung dung", "app"],
    ask: ["hoi"],
    attachment: ["tep dinh kem"],
    audio: ["am thanh"],
    automation: ["tu dong hoa"],
    availability: ["lich ranh", "kha dung"],
    bash: ["bash", "terminal"],
    book: ["dat", "dat cho"],
    browser: ["trinh duyet"],
    calendar: ["lich"],
    call: ["cuoc goi", "goi"],
    character: ["nhan vat", "tinh cach"],
    check: ["kiem tra"],
    code: ["ma", "code"],
    comment: ["binh luan"],
    complete: ["hoan thanh"],
    computer: ["may tinh"],
    config: ["cau hinh"],
    configure: ["cau hinh"],
    connector: ["ket noi", "tich hop"],
    contact: ["lien he"],
    create: ["tao"],
    credential: ["thong tin dang nhap"],
    crypto: ["tien ma hoa", "crypto"],
    data: ["du lieu"],
    database: ["co so du lieu"],
    delete: ["xoa"],
    desktop: ["man hinh"],
    document: ["tai lieu"],
    download: ["tai xuong"],
    draft: ["ban nhap"],
    edit: ["chinh sua", "sua"],
    email: ["email", "thu"],
    execute: ["chay", "thuc thi"],
    fetch: ["lay", "tai"],
    file: ["tep"],
    finance: ["tai chinh"],
    find: ["tim"],
    follow: ["theo doi"],
    form: ["bieu mau"],
    game: ["tro choi"],
    generate: ["tao", "sinh"],
    get: ["lay", "xem"],
    health: ["suc khoe"],
    image: ["hinh anh", "anh"],
    inbox: ["hop thu"],
    install: ["cai dat"],
    issue: ["van de", "ticket", "tac vu"],
    key: ["khoa"],
    knowledge: ["kien thuc"],
    list: ["liet ke", "hien thi"],
    log: ["nhat ky", "log"],
    manage: ["quan ly"],
    media: ["phuong tien"],
    memory: ["bo nho", "ky uc"],
    message: ["tin nhan"],
    music: ["nhac"],
    mute: ["tat tieng"],
    open: ["mo"],
    page: ["trang"],
    password: ["mat khau"],
    payment: ["thanh toan"],
    phone: ["dien thoai"],
    plan: ["ke hoach"],
    play: ["phat", "choi"],
    plugin: ["plugin", "tien ich"],
    post: ["dang", "bai viet"],
    profile: ["ho so"],
    question: ["cau hoi"],
    read: ["doc"],
    reminder: ["nhac nho"],
    remove: ["xoa", "go bo"],
    reply: ["tra loi"],
    request: ["yeu cau"],
    role: ["vai tro", "quyen"],
    room: ["phong", "chat"],
    route: ["dinh tuyen", "tuyen"],
    runtime: ["runtime", "trang thai"],
    save: ["luu"],
    schedule: ["len lich", "lich"],
    search: ["tim kiem"],
    secret: ["bi mat", "khoa", "thong tin dang nhap"],
    send: ["gui"],
    setting: ["cai dat", "cau hinh"],
    setup: ["thiet lap"],
    skill: ["ky nang", "skill"],
    social: ["mang xa hoi"],
    state: ["trang thai"],
    stream: ["phat truc tiep", "stream"],
    task: ["tac vu", "viec"],
    terminal: ["terminal"],
    todo: ["viec can lam", "todo"],
    token: ["token"],
    transfer: ["chuyen"],
    travel: ["du lich", "chuyen di"],
    trust: ["tin cay"],
    update: ["cap nhat"],
    user: ["nguoi dung"],
    video: ["video"],
    vision: ["thi giac", "tam nhin"],
    wallet: ["vi", "wallet"],
    web: ["web", "internet"],
    workflow: ["quy trinh"],
    world: ["the gioi"],
    write: ["viet", "ghi"],
    zone: ["vung", "zone"],
  },
  "zh-CN": {
    account: ["账户"],
    activity: ["活动"],
    add: ["添加"],
    admin: ["管理员"],
    agent: ["代理", "智能体"],
    analyze: ["分析"],
    app: ["应用"],
    ask: ["询问", "提问"],
    attachment: ["附件"],
    audio: ["音频"],
    automation: ["自动化"],
    availability: ["可用时间", "空闲"],
    bash: ["终端", "命令行"],
    book: ["预订"],
    browser: ["浏览器"],
    calendar: ["日历"],
    call: ["电话", "通话"],
    character: ["角色", "性格"],
    check: ["检查", "查看"],
    code: ["代码"],
    comment: ["评论"],
    complete: ["完成"],
    computer: ["电脑"],
    config: ["配置"],
    configure: ["配置", "设置"],
    connector: ["连接器", "集成"],
    contact: ["联系人"],
    create: ["创建", "新建"],
    credential: ["凭据"],
    crypto: ["加密货币", "链上"],
    data: ["数据"],
    database: ["数据库"],
    delete: ["删除"],
    desktop: ["桌面"],
    document: ["文档"],
    download: ["下载"],
    draft: ["草稿"],
    edit: ["编辑", "修改"],
    email: ["邮件", "邮箱"],
    execute: ["执行", "运行"],
    fetch: ["获取"],
    file: ["文件"],
    finance: ["财务", "金融"],
    find: ["查找", "寻找"],
    follow: ["关注"],
    form: ["表单"],
    game: ["游戏"],
    generate: ["生成"],
    get: ["获取", "查看"],
    health: ["健康"],
    image: ["图片", "图像", "照片"],
    inbox: ["收件箱"],
    install: ["安装"],
    issue: ["问题", "工单", "任务"],
    key: ["密钥"],
    knowledge: ["知识"],
    list: ["列出", "显示"],
    log: ["日志"],
    manage: ["管理"],
    media: ["媒体"],
    memory: ["记忆", "内存"],
    message: ["消息"],
    music: ["音乐"],
    mute: ["静音"],
    open: ["打开"],
    page: ["页面"],
    password: ["密码"],
    payment: ["付款", "支付"],
    phone: ["电话"],
    plan: ["计划"],
    play: ["播放"],
    plugin: ["插件"],
    post: ["发布", "帖子"],
    profile: ["资料"],
    question: ["问题"],
    read: ["读取", "阅读"],
    reminder: ["提醒"],
    remove: ["移除", "删除"],
    reply: ["回复"],
    request: ["请求"],
    role: ["角色", "权限"],
    room: ["房间", "聊天室"],
    route: ["路由", "路线"],
    runtime: ["运行时", "状态"],
    save: ["保存"],
    schedule: ["安排", "日程"],
    search: ["搜索"],
    secret: ["密钥", "秘密", "凭据"],
    send: ["发送"],
    setting: ["设置", "配置"],
    setup: ["设置", "配置"],
    skill: ["技能"],
    social: ["社交"],
    state: ["状态"],
    stream: ["直播", "流"],
    task: ["任务"],
    terminal: ["终端"],
    todo: ["待办", "任务"],
    token: ["令牌"],
    transfer: ["转账", "传输"],
    travel: ["旅行", "出行"],
    trust: ["信任"],
    update: ["更新"],
    user: ["用户"],
    video: ["视频"],
    vision: ["视觉"],
    wallet: ["钱包"],
    web: ["网络", "网页"],
    workflow: ["工作流"],
    world: ["世界"],
    write: ["写入", "编写"],
    zone: ["区域"],
  },
};

function main() {
  const audit = JSON.parse(
    execFileSync("node", ["scripts/audit-action-availability.mjs", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  );
  const contextKeywords = JSON.parse(
    readFileSync(join(ROOT, CONTEXT_KEYWORD_FILE), "utf8"),
  );
  const entries = {};

  for (const action of audit.actions) {
    const stem = actionNameToKeywordStem(action.name);
    if (!stem) continue;

    const key = `action.${stem}.request`;
    const existing = entries[key] ?? { base: [] };
    const baseTerms = new Set(existing.base);

    addTerm(baseTerms, action.name);
    for (const simile of action.similes ?? []) addTerm(baseTerms, simile);
    for (const context of action.contexts ?? []) {
      const contextPhrase = phrase(context);
      if (contextPhrase) addTerm(baseTerms, `${contextPhrase} ${phrase(action.name)}`);
    }

    const entry = { base: limitTerms(baseTerms, MAX_BASE_TERMS) };
    for (const locale of SUPPORTED_LOCALES) {
      entry[locale] = buildLocaleTerms({
        action,
        baseTerms: entry.base,
        contextKeywords,
        locale,
      });
    }
    entries[key] = entry;
  }

  const output = {
    $schema: "./keywords.schema.json",
    locales: SUPPORTED_LOCALES,
    entries: Object.fromEntries(
      Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };

  writeFileSync(join(ROOT, OUTPUT_FILE), `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Generated ${Object.keys(output.entries).length} action keyword entries in ${OUTPUT_FILE}`,
  );
}

function buildLocaleTerms({ action, baseTerms, contextKeywords, locale }) {
  const terms = new Set();
  const exactPhraseMap = PHRASE_TRANSLATIONS[locale] ?? {};

  for (const base of baseTerms) {
    const normalized = phrase(base);
    for (const translated of exactPhraseMap[normalized] ?? []) {
      addTerm(terms, translated);
    }
    for (const translated of translatePhrase(normalized, locale)) {
      addTerm(terms, translated);
    }
    for (const token of tokens(normalized)) {
      for (const translatedToken of TOKEN_TRANSLATIONS[locale]?.[token] ?? []) {
        addTerm(terms, translatedToken);
      }
    }
  }

  for (const context of action.contexts ?? []) {
    for (const contextTerm of getContextLocaleTerms(contextKeywords, context, locale)) {
      addTerm(terms, contextTerm);
    }
  }

  if (terms.size === 0) {
    for (const base of baseTerms.slice(0, 8)) addTerm(terms, base);
  }

  return limitTerms(terms, MAX_LOCALE_TERMS);
}

function translatePhrase(value, locale) {
  const dictionary = TOKEN_TRANSLATIONS[locale] ?? {};
  const parts = tokens(value);
  if (parts.length === 0) return [];

  let changed = false;
  const translated = parts.map((part) => {
    const replacement = dictionary[part]?.[0];
    if (replacement) changed = true;
    return replacement ?? part;
  });

  const out = [];
  if (changed) out.push(translated.join(" "));

  if (parts.length > 1) {
    const translatedPairs = [];
    for (let index = 0; index < parts.length - 1; index += 1) {
      const left = dictionary[parts[index]]?.[0];
      const right = dictionary[parts[index + 1]]?.[0];
      if (left || right) translatedPairs.push(`${left ?? parts[index]} ${right ?? parts[index + 1]}`);
    }
    out.push(...translatedPairs);
  }

  return out;
}

function getContextLocaleTerms(contextKeywords, context, locale) {
  const key = `contextSignal.${context}.strong`;
  const entry = contextKeywords.entries?.[key];
  if (!entry) return [];
  return Array.isArray(entry[locale]) ? entry[locale] : [];
}

function actionNameToKeywordStem(actionName) {
  const words = String(actionName ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/g)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return "";
  return [words[0], ...words.slice(1).map(capitalizeAscii)].join("");
}

function capitalizeAscii(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function phrase(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokens(value) {
  return phrase(value)
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function addTerm(terms, value) {
  const text = phrase(value);
  if (!text) return;
  terms.add(text);
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw && raw !== text && raw.length <= 80) terms.add(raw);
}

function limitTerms(terms, limit) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const normalized = phrase(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

main();
