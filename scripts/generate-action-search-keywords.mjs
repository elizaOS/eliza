#!/usr/bin/env node
/**
 * Generate multilingual action-search keyword metadata.
 *
 * This is retrieval/ranking metadata only. Do not use these terms as hard
 * action availability checks; validate() should stay state/service based.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ACTION_KEYWORDS_PATH = join(
  ROOT,
  "packages/shared/src/i18n/keywords/action-search.generated.keywords.json",
);
const CONTEXT_KEYWORDS_PATH = join(
  ROOT,
  "packages/shared/src/i18n/keywords/context-search.keywords.json",
);
const SUPPORTED_LOCALES = ["es", "ko", "pt", "tl", "vi", "zh-CN"];
const BASE_LIMIT = 96;
const LOCALE_LIMIT = 48;

const FALLBACK_LOCALE_TERMS = {
  es: ["accion", "herramienta", "solicitud"],
  ko: ["작업", "도구", "요청"],
  pt: ["acao", "ferramenta", "solicitacao"],
  tl: ["aksyon", "kasangkapan", "kahilingan"],
  vi: ["hành động", "hanh dong", "công cụ", "cong cu", "yêu cầu", "yeu cau"],
  "zh-CN": ["操作", "工具", "请求"],
};

const PRESERVE_UNTRANSLATED_TOKENS = new Set([
  "api",
  "aws",
  "bash",
  "bluesky",
  "cli",
  "cron",
  "css",
  "defi",
  "discord",
  "gmail",
  "github",
  "google",
  "html",
  "ios",
  "json",
  "linear",
  "mcp",
  "nostr",
  "oauth",
  "ocr",
  "pr",
  "shopify",
  "slack",
  "sql",
  "telegram",
  "url",
  "wallet",
  "x",
]);

const TOKEN_TRANSLATIONS = {
  account: {
    es: ["cuenta"],
    ko: ["계정"],
    pt: ["conta"],
    tl: ["account", "kuwenta"],
    vi: ["tài khoản", "tai khoan"],
    "zh-CN": ["账户", "账号"],
  },
  action: {
    es: ["accion"],
    ko: ["작업"],
    pt: ["acao"],
    tl: ["aksyon"],
    vi: ["hành động", "hanh dong"],
    "zh-CN": ["操作"],
  },
  add: {
    es: ["agregar", "anadir"],
    ko: ["추가"],
    pt: ["adicionar"],
    tl: ["idagdag"],
    vi: ["thêm", "them"],
    "zh-CN": ["添加"],
  },
  admin: {
    es: ["administrador"],
    ko: ["관리자"],
    pt: ["administrador"],
    tl: ["admin"],
    vi: ["quản trị", "quan tri"],
    "zh-CN": ["管理员"],
  },
  agent: {
    es: ["agente"],
    ko: ["에이전트"],
    pt: ["agente"],
    tl: ["agent"],
    vi: ["tác tử", "tac tu"],
    "zh-CN": ["代理", "智能体"],
  },
  alarm: {
    es: ["alarma"],
    ko: ["알람"],
    pt: ["alarme"],
    tl: ["alarm"],
    vi: ["báo thức", "bao thuc"],
    "zh-CN": ["闹钟"],
  },
  analyze: {
    es: ["analizar"],
    ko: ["분석"],
    pt: ["analisar"],
    tl: ["suriin"],
    vi: ["phân tích", "phan tich"],
    "zh-CN": ["分析"],
  },
  app: {
    es: ["aplicacion", "app"],
    ko: ["앱"],
    pt: ["aplicativo", "app"],
    tl: ["app"],
    vi: ["ứng dụng", "ung dung"],
    "zh-CN": ["应用"],
  },
  archive: {
    es: ["archivar"],
    ko: ["보관"],
    pt: ["arquivar"],
    tl: ["i-archive"],
    vi: ["lưu trữ", "luu tru"],
    "zh-CN": ["归档"],
  },
  ask: {
    es: ["preguntar"],
    ko: ["질문"],
    pt: ["perguntar"],
    tl: ["magtanong"],
    vi: ["hỏi", "hoi"],
    "zh-CN": ["询问"],
  },
  attachment: {
    es: ["adjunto"],
    ko: ["첨부파일"],
    pt: ["anexo"],
    tl: ["attachment"],
    vi: ["tệp đính kèm", "tep dinh kem"],
    "zh-CN": ["附件"],
  },
  audio: {
    es: ["audio"],
    ko: ["오디오"],
    pt: ["audio"],
    tl: ["audio"],
    vi: ["âm thanh", "am thanh"],
    "zh-CN": ["音频"],
  },
  automation: {
    es: ["automatizacion"],
    ko: ["자동화"],
    pt: ["automacao"],
    tl: ["automation"],
    vi: ["tự động hóa", "tu dong hoa"],
    "zh-CN": ["自动化"],
  },
  availability: {
    es: ["disponibilidad"],
    ko: ["가능 시간"],
    pt: ["disponibilidade"],
    tl: ["availability"],
    vi: ["lịch rảnh", "lich ranh"],
    "zh-CN": ["可用时间"],
  },
  balance: {
    es: ["saldo"],
    ko: ["잔액"],
    pt: ["saldo"],
    tl: ["balance"],
    vi: ["số dư", "so du"],
    "zh-CN": ["余额"],
  },
  bash: {
    es: ["bash", "terminal"],
    ko: ["배시", "터미널"],
    pt: ["bash", "terminal"],
    tl: ["bash", "terminal"],
    vi: ["bash", "terminal"],
    "zh-CN": ["bash", "终端"],
  },
  billing: {
    es: ["facturacion"],
    ko: ["청구"],
    pt: ["faturamento"],
    tl: ["billing"],
    vi: ["thanh toán", "thanh toan"],
    "zh-CN": ["账单"],
  },
  block: {
    es: ["bloquear"],
    ko: ["차단"],
    pt: ["bloquear"],
    tl: ["i-block"],
    vi: ["chặn", "chan"],
    "zh-CN": ["阻止"],
  },
  book: {
    es: ["reservar"],
    ko: ["예약"],
    pt: ["reservar"],
    tl: ["mag-book", "ireserba"],
    vi: ["đặt", "dat"],
    "zh-CN": ["预订"],
  },
  browser: {
    es: ["navegador"],
    ko: ["브라우저"],
    pt: ["navegador"],
    tl: ["browser"],
    vi: ["trình duyệt", "trinh duyet"],
    "zh-CN": ["浏览器"],
  },
  call: {
    es: ["llamar", "llamada"],
    ko: ["통화", "전화"],
    pt: ["ligar", "chamada"],
    tl: ["tawag"],
    vi: ["gọi", "goi"],
    "zh-CN": ["通话", "拨打"],
  },
  calendar: {
    es: ["calendario"],
    ko: ["캘린더", "일정"],
    pt: ["calendario"],
    tl: ["kalendaryo"],
    vi: ["lịch", "lich"],
    "zh-CN": ["日历"],
  },
  capture: {
    es: ["capturar"],
    ko: ["캡처"],
    pt: ["capturar"],
    tl: ["kuha"],
    vi: ["chụp", "chup"],
    "zh-CN": ["捕获", "截图"],
  },
  character: {
    es: ["personaje"],
    ko: ["캐릭터"],
    pt: ["personagem"],
    tl: ["karakter"],
    vi: ["nhân vật", "nhan vat"],
    "zh-CN": ["角色"],
  },
  chat: {
    es: ["chat", "conversacion"],
    ko: ["채팅", "대화"],
    pt: ["chat", "conversa"],
    tl: ["chat", "usap"],
    vi: ["trò chuyện", "tro chuyen"],
    "zh-CN": ["聊天"],
  },
  check: {
    es: ["revisar", "comprobar"],
    ko: ["확인"],
    pt: ["verificar"],
    tl: ["suriin"],
    vi: ["kiểm tra", "kiem tra"],
    "zh-CN": ["检查"],
  },
  clear: {
    es: ["limpiar", "borrar"],
    ko: ["지우기"],
    pt: ["limpar"],
    tl: ["linisin"],
    vi: ["xóa", "xoa"],
    "zh-CN": ["清除"],
  },
  click: {
    es: ["clic", "hacer clic"],
    ko: ["클릭"],
    pt: ["clicar"],
    tl: ["click"],
    vi: ["nhấp", "nhap"],
    "zh-CN": ["点击"],
  },
  code: {
    es: ["codigo"],
    ko: ["코드"],
    pt: ["codigo"],
    tl: ["code"],
    vi: ["mã", "ma"],
    "zh-CN": ["代码"],
  },
  command: {
    es: ["comando"],
    ko: ["명령"],
    pt: ["comando"],
    tl: ["command"],
    vi: ["lệnh", "lenh"],
    "zh-CN": ["命令"],
  },
  comment: {
    es: ["comentario"],
    ko: ["댓글"],
    pt: ["comentario"],
    tl: ["komento"],
    vi: ["bình luận", "binh luan"],
    "zh-CN": ["评论"],
  },
  complete: {
    es: ["completar", "terminar"],
    ko: ["완료"],
    pt: ["concluir", "completar"],
    tl: ["tapusin"],
    vi: ["hoàn thành", "hoan thanh"],
    "zh-CN": ["完成"],
  },
  computer: {
    es: ["computadora", "ordenador"],
    ko: ["컴퓨터"],
    pt: ["computador"],
    tl: ["computer"],
    vi: ["máy tính", "may tinh"],
    "zh-CN": ["电脑"],
  },
  configure: {
    es: ["configurar"],
    ko: ["설정"],
    pt: ["configurar"],
    tl: ["i-configure"],
    vi: ["cấu hình", "cau hinh"],
    "zh-CN": ["配置"],
  },
  connect: {
    es: ["conectar"],
    ko: ["연결"],
    pt: ["conectar"],
    tl: ["ikonekta"],
    vi: ["kết nối", "ket noi"],
    "zh-CN": ["连接"],
  },
  connector: {
    es: ["conector"],
    ko: ["커넥터"],
    pt: ["conector"],
    tl: ["connector"],
    vi: ["kết nối", "ket noi"],
    "zh-CN": ["连接器"],
  },
  contact: {
    es: ["contacto"],
    ko: ["연락처"],
    pt: ["contato"],
    tl: ["contact"],
    vi: ["liên hệ", "lien he"],
    "zh-CN": ["联系人"],
  },
  control: {
    es: ["controlar"],
    ko: ["제어"],
    pt: ["controlar"],
    tl: ["kontrol"],
    vi: ["điều khiển", "dieu khien"],
    "zh-CN": ["控制"],
  },
  create: {
    es: ["crear"],
    ko: ["생성"],
    pt: ["criar"],
    tl: ["gumawa"],
    vi: ["tạo", "tao"],
    "zh-CN": ["创建"],
  },
  crypto: {
    es: ["cripto"],
    ko: ["암호화폐"],
    pt: ["cripto"],
    tl: ["crypto"],
    vi: ["tiền mã hóa", "tien ma hoa"],
    "zh-CN": ["加密货币"],
  },
  database: {
    es: ["base de datos"],
    ko: ["데이터베이스"],
    pt: ["banco de dados"],
    tl: ["database"],
    vi: ["cơ sở dữ liệu", "co so du lieu"],
    "zh-CN": ["数据库"],
  },
  delete: {
    es: ["eliminar", "borrar"],
    ko: ["삭제"],
    pt: ["excluir", "apagar"],
    tl: ["burahin"],
    vi: ["xóa", "xoa"],
    "zh-CN": ["删除"],
  },
  describe: {
    es: ["describir"],
    ko: ["설명"],
    pt: ["descrever"],
    tl: ["ilarawan"],
    vi: ["mô tả", "mo ta"],
    "zh-CN": ["描述"],
  },
  desktop: {
    es: ["escritorio"],
    ko: ["데스크톱"],
    pt: ["area de trabalho"],
    tl: ["desktop"],
    vi: ["máy tính để bàn", "may tinh de ban"],
    "zh-CN": ["桌面"],
  },
  details: {
    es: ["detalles"],
    ko: ["세부정보"],
    pt: ["detalhes"],
    tl: ["detalye"],
    vi: ["chi tiết", "chi tiet"],
    "zh-CN": ["详情"],
  },
  disable: {
    es: ["desactivar"],
    ko: ["비활성화"],
    pt: ["desativar"],
    tl: ["i-disable"],
    vi: ["tắt", "tat"],
    "zh-CN": ["禁用"],
  },
  document: {
    es: ["documento"],
    ko: ["문서"],
    pt: ["documento"],
    tl: ["dokumento"],
    vi: ["tài liệu", "tai lieu"],
    "zh-CN": ["文档"],
  },
  download: {
    es: ["descargar"],
    ko: ["다운로드"],
    pt: ["baixar"],
    tl: ["i-download"],
    vi: ["tải xuống", "tai xuong"],
    "zh-CN": ["下载"],
  },
  draft: {
    es: ["borrador"],
    ko: ["초안"],
    pt: ["rascunho"],
    tl: ["draft"],
    vi: ["bản nháp", "ban nhap"],
    "zh-CN": ["草稿"],
  },
  edit: {
    es: ["editar"],
    ko: ["편집"],
    pt: ["editar"],
    tl: ["i-edit"],
    vi: ["chỉnh sửa", "chinh sua"],
    "zh-CN": ["编辑"],
  },
  email: {
    es: ["correo", "email"],
    ko: ["이메일"],
    pt: ["email", "correio"],
    tl: ["email", "koreo"],
    vi: ["email", "thư", "thu"],
    "zh-CN": ["邮件"],
  },
  enable: {
    es: ["activar"],
    ko: ["활성화"],
    pt: ["ativar"],
    tl: ["i-enable"],
    vi: ["bật", "bat"],
    "zh-CN": ["启用"],
  },
  execute: {
    es: ["ejecutar"],
    ko: ["실행"],
    pt: ["executar"],
    tl: ["patakbuhin"],
    vi: ["thực thi", "thuc thi"],
    "zh-CN": ["执行"],
  },
  extract: {
    es: ["extraer"],
    ko: ["추출"],
    pt: ["extrair"],
    tl: ["kunin"],
    vi: ["trích xuất", "trich xuat"],
    "zh-CN": ["提取"],
  },
  file: {
    es: ["archivo"],
    ko: ["파일"],
    pt: ["arquivo"],
    tl: ["file"],
    vi: ["tệp", "tep"],
    "zh-CN": ["文件"],
  },
  find: {
    es: ["buscar", "encontrar"],
    ko: ["찾기"],
    pt: ["encontrar", "buscar"],
    tl: ["hanapin"],
    vi: ["tìm", "tim"],
    "zh-CN": ["查找"],
  },
  finish: {
    es: ["finalizar"],
    ko: ["완료"],
    pt: ["finalizar"],
    tl: ["tapusin"],
    vi: ["kết thúc", "ket thuc"],
    "zh-CN": ["结束"],
  },
  follow: {
    es: ["seguir"],
    ko: ["팔로우"],
    pt: ["seguir"],
    tl: ["sundan"],
    vi: ["theo dõi", "theo doi"],
    "zh-CN": ["关注"],
  },
  game: {
    es: ["juego"],
    ko: ["게임"],
    pt: ["jogo"],
    tl: ["laro"],
    vi: ["trò chơi", "tro choi"],
    "zh-CN": ["游戏"],
  },
  generate: {
    es: ["generar"],
    ko: ["생성"],
    pt: ["gerar"],
    tl: ["bumuo"],
    vi: ["tạo", "tao"],
    "zh-CN": ["生成"],
  },
  get: {
    es: ["obtener"],
    ko: ["가져오기"],
    pt: ["obter"],
    tl: ["kunin"],
    vi: ["lấy", "lay"],
    "zh-CN": ["获取"],
  },
  goal: {
    es: ["meta", "objetivo"],
    ko: ["목표"],
    pt: ["meta", "objetivo"],
    tl: ["layunin"],
    vi: ["mục tiêu", "muc tieu"],
    "zh-CN": ["目标"],
  },
  grep: {
    es: ["buscar texto", "grep"],
    ko: ["텍스트 검색", "grep"],
    pt: ["buscar texto", "grep"],
    tl: ["hanapin text", "grep"],
    vi: ["tìm văn bản", "tim van ban", "grep"],
    "zh-CN": ["文本搜索", "grep"],
  },
  health: {
    es: ["salud"],
    ko: ["건강"],
    pt: ["saude"],
    tl: ["kalusugan"],
    vi: ["sức khỏe", "suc khoe"],
    "zh-CN": ["健康"],
  },
  history: {
    es: ["historial"],
    ko: ["기록"],
    pt: ["historico"],
    tl: ["history"],
    vi: ["lịch sử", "lich su"],
    "zh-CN": ["历史"],
  },
  image: {
    es: ["imagen", "foto"],
    ko: ["이미지", "사진"],
    pt: ["imagem", "foto"],
    tl: ["larawan"],
    vi: ["hình ảnh", "hinh anh", "ảnh", "anh"],
    "zh-CN": ["图片", "图像"],
  },
  inbox: {
    es: ["bandeja de entrada"],
    ko: ["받은편지함"],
    pt: ["caixa de entrada"],
    tl: ["inbox"],
    vi: ["hộp thư", "hop thu"],
    "zh-CN": ["收件箱"],
  },
  install: {
    es: ["instalar"],
    ko: ["설치"],
    pt: ["instalar"],
    tl: ["i-install"],
    vi: ["cài đặt", "cai dat"],
    "zh-CN": ["安装"],
  },
  inventory: {
    es: ["inventario"],
    ko: ["재고"],
    pt: ["inventario", "estoque"],
    tl: ["imbentaryo"],
    vi: ["hàng tồn kho", "hang ton kho"],
    "zh-CN": ["库存"],
  },
  issue: {
    es: ["incidencia", "tarea"],
    ko: ["이슈"],
    pt: ["problema", "issue"],
    tl: ["isyu"],
    vi: ["vấn đề", "van de"],
    "zh-CN": ["问题"],
  },
  key: {
    es: ["clave", "tecla"],
    ko: ["키"],
    pt: ["chave", "tecla"],
    tl: ["key"],
    vi: ["khóa", "khoa", "phím", "phim"],
    "zh-CN": ["键", "密钥"],
  },
  knowledge: {
    es: ["conocimiento"],
    ko: ["지식"],
    pt: ["conhecimento"],
    tl: ["kaalaman"],
    vi: ["kiến thức", "kien thuc"],
    "zh-CN": ["知识"],
  },
  linear: {
    es: ["linear"],
    ko: ["리니어"],
    pt: ["linear"],
    tl: ["linear"],
    vi: ["linear"],
    "zh-CN": ["linear"],
  },
  list: {
    es: ["listar", "mostrar"],
    ko: ["목록"],
    pt: ["listar", "mostrar"],
    tl: ["ilista"],
    vi: ["liệt kê", "liet ke"],
    "zh-CN": ["列出"],
  },
  login: {
    es: ["iniciar sesion"],
    ko: ["로그인"],
    pt: ["entrar", "login"],
    tl: ["mag-login"],
    vi: ["đăng nhập", "dang nhap"],
    "zh-CN": ["登录"],
  },
  logs: {
    es: ["registros", "logs"],
    ko: ["로그"],
    pt: ["logs", "registros"],
    tl: ["logs"],
    vi: ["nhật ký", "nhat ky"],
    "zh-CN": ["日志"],
  },
  manage: {
    es: ["gestionar", "administrar"],
    ko: ["관리"],
    pt: ["gerenciar"],
    tl: ["pamahalaan"],
    vi: ["quản lý", "quan ly"],
    "zh-CN": ["管理"],
  },
  memory: {
    es: ["memoria"],
    ko: ["기억"],
    pt: ["memoria"],
    tl: ["memory", "alaala"],
    vi: ["ký ức", "ky uc"],
    "zh-CN": ["记忆"],
  },
  message: {
    es: ["mensaje"],
    ko: ["메시지"],
    pt: ["mensagem"],
    tl: ["mensahe"],
    vi: ["tin nhắn", "tin nhan"],
    "zh-CN": ["消息"],
  },
  mute: {
    es: ["silenciar"],
    ko: ["음소거"],
    pt: ["silenciar"],
    tl: ["i-mute"],
    vi: ["tắt tiếng", "tat tieng"],
    "zh-CN": ["静音"],
  },
  music: {
    es: ["musica"],
    ko: ["음악"],
    pt: ["musica"],
    tl: ["musika"],
    vi: ["nhạc", "nhac"],
    "zh-CN": ["音乐"],
  },
  oauth: {
    es: ["oauth", "autorizacion"],
    ko: ["oauth", "인증"],
    pt: ["oauth", "autorizacao"],
    tl: ["oauth"],
    vi: ["oauth", "ủy quyền", "uy quyen"],
    "zh-CN": ["oauth", "授权"],
  },
  open: {
    es: ["abrir"],
    ko: ["열기"],
    pt: ["abrir"],
    tl: ["buksan"],
    vi: ["mở", "mo"],
    "zh-CN": ["打开"],
  },
  order: {
    es: ["pedido", "orden"],
    ko: ["주문"],
    pt: ["pedido"],
    tl: ["order"],
    vi: ["đơn hàng", "don hang"],
    "zh-CN": ["订单"],
  },
  page: {
    es: ["pagina"],
    ko: ["페이지"],
    pt: ["pagina"],
    tl: ["pahina"],
    vi: ["trang"],
    "zh-CN": ["页面"],
  },
  password: {
    es: ["contrasena"],
    ko: ["비밀번호"],
    pt: ["senha"],
    tl: ["password"],
    vi: ["mật khẩu", "mat khau"],
    "zh-CN": ["密码"],
  },
  pay: {
    es: ["pagar"],
    ko: ["지불"],
    pt: ["pagar"],
    tl: ["magbayad"],
    vi: ["trả tiền", "tra tien"],
    "zh-CN": ["支付"],
  },
  payment: {
    es: ["pago"],
    ko: ["결제"],
    pt: ["pagamento"],
    tl: ["bayad"],
    vi: ["thanh toán", "thanh toan"],
    "zh-CN": ["付款"],
  },
  plan: {
    es: ["plan"],
    ko: ["계획"],
    pt: ["plano"],
    tl: ["plano"],
    vi: ["kế hoạch", "ke hoach"],
    "zh-CN": ["计划"],
  },
  play: {
    es: ["reproducir", "tocar"],
    ko: ["재생"],
    pt: ["tocar", "reproduzir"],
    tl: ["patugtugin"],
    vi: ["phát", "phat"],
    "zh-CN": ["播放"],
  },
  plugin: {
    es: ["plugin", "complemento"],
    ko: ["플러그인"],
    pt: ["plugin"],
    tl: ["plugin"],
    vi: ["plugin"],
    "zh-CN": ["插件"],
  },
  post: {
    es: ["publicacion", "publicar"],
    ko: ["게시물", "게시"],
    pt: ["postagem", "publicar"],
    tl: ["post"],
    vi: ["bài đăng", "bai dang"],
    "zh-CN": ["帖子", "发布"],
  },
  product: {
    es: ["producto"],
    ko: ["상품"],
    pt: ["produto"],
    tl: ["produkto"],
    vi: ["sản phẩm", "san pham"],
    "zh-CN": ["产品"],
  },
  profile: {
    es: ["perfil"],
    ko: ["프로필"],
    pt: ["perfil"],
    tl: ["profile"],
    vi: ["hồ sơ", "ho so"],
    "zh-CN": ["资料"],
  },
  publish: {
    es: ["publicar"],
    ko: ["게시"],
    pt: ["publicar"],
    tl: ["i-publish"],
    vi: ["xuất bản", "xuat ban"],
    "zh-CN": ["发布"],
  },
  query: {
    es: ["consulta"],
    ko: ["쿼리", "질의"],
    pt: ["consulta"],
    tl: ["query"],
    vi: ["truy vấn", "truy van"],
    "zh-CN": ["查询"],
  },
  read: {
    es: ["leer"],
    ko: ["읽기"],
    pt: ["ler"],
    tl: ["basahin"],
    vi: ["đọc", "doc"],
    "zh-CN": ["读取"],
  },
  reflection: {
    es: ["reflexion"],
    ko: ["성찰"],
    pt: ["reflexao"],
    tl: ["pagninilay"],
    vi: ["phản ánh", "phan anh"],
    "zh-CN": ["反思"],
  },
  reminder: {
    es: ["recordatorio"],
    ko: ["리마인더", "알림"],
    pt: ["lembrete"],
    tl: ["paalala"],
    vi: ["nhắc nhở", "nhac nho"],
    "zh-CN": ["提醒"],
  },
  remove: {
    es: ["eliminar", "quitar"],
    ko: ["제거"],
    pt: ["remover"],
    tl: ["alisin"],
    vi: ["gỡ", "go"],
    "zh-CN": ["移除"],
  },
  reply: {
    es: ["responder"],
    ko: ["답장"],
    pt: ["responder"],
    tl: ["sagot", "sumagot"],
    vi: ["trả lời", "tra loi"],
    "zh-CN": ["回复"],
  },
  request: {
    es: ["solicitud", "pedir"],
    ko: ["요청"],
    pt: ["solicitacao", "pedir"],
    tl: ["kahilingan", "hiling"],
    vi: ["yêu cầu", "yeu cau"],
    "zh-CN": ["请求"],
  },
  role: {
    es: ["rol"],
    ko: ["역할"],
    pt: ["funcao", "papel"],
    tl: ["role"],
    vi: ["vai trò", "vai tro"],
    "zh-CN": ["角色"],
  },
  room: {
    es: ["sala", "chat"],
    ko: ["방", "채팅방"],
    pt: ["sala", "chat"],
    tl: ["room", "kuwarto"],
    vi: ["phòng", "phong"],
    "zh-CN": ["房间", "聊天室"],
  },
  run: {
    es: ["ejecutar"],
    ko: ["실행"],
    pt: ["executar"],
    tl: ["patakbuhin"],
    vi: ["chạy", "chay"],
    "zh-CN": ["运行"],
  },
  schedule: {
    es: ["programar", "agendar"],
    ko: ["예약", "일정"],
    pt: ["agendar"],
    tl: ["i-schedule"],
    vi: ["lên lịch", "len lich"],
    "zh-CN": ["安排"],
  },
  screen: {
    es: ["pantalla"],
    ko: ["화면"],
    pt: ["tela"],
    tl: ["screen"],
    vi: ["màn hình", "man hinh"],
    "zh-CN": ["屏幕"],
  },
  screenshot: {
    es: ["captura de pantalla"],
    ko: ["스크린샷"],
    pt: ["captura de tela"],
    tl: ["screenshot"],
    vi: ["ảnh chụp màn hình", "anh chup man hinh"],
    "zh-CN": ["截图"],
  },
  search: {
    es: ["buscar"],
    ko: ["검색"],
    pt: ["buscar"],
    tl: ["maghanap"],
    vi: ["tìm kiếm", "tim kiem"],
    "zh-CN": ["搜索"],
  },
  secret: {
    es: ["secreto", "clave secreta"],
    ko: ["비밀", "시크릿"],
    pt: ["segredo"],
    tl: ["secret"],
    vi: ["bí mật", "bi mat"],
    "zh-CN": ["密钥", "秘密"],
  },
  send: {
    es: ["enviar"],
    ko: ["보내기"],
    pt: ["enviar"],
    tl: ["ipadala"],
    vi: ["gửi", "gui"],
    "zh-CN": ["发送"],
  },
  settings: {
    es: ["configuracion"],
    ko: ["설정"],
    pt: ["configuracoes"],
    tl: ["settings"],
    vi: ["cài đặt", "cai dat"],
    "zh-CN": ["设置"],
  },
  shopify: {
    es: ["shopify", "tienda"],
    ko: ["쇼피파이", "스토어"],
    pt: ["shopify", "loja"],
    tl: ["shopify", "tindahan"],
    vi: ["shopify", "cửa hàng", "cua hang"],
    "zh-CN": ["shopify", "商店"],
  },
  skill: {
    es: ["habilidad", "skill"],
    ko: ["스킬"],
    pt: ["habilidade", "skill"],
    tl: ["skill", "kasanayan"],
    vi: ["kỹ năng", "ky nang"],
    "zh-CN": ["技能"],
  },
  social: {
    es: ["social"],
    ko: ["소셜"],
    pt: ["social"],
    tl: ["social"],
    vi: ["mạng xã hội", "mang xa hoi"],
    "zh-CN": ["社交"],
  },
  stop: {
    es: ["detener", "parar"],
    ko: ["중지"],
    pt: ["parar"],
    tl: ["itigil"],
    vi: ["dừng", "dung"],
    "zh-CN": ["停止"],
  },
  store: {
    es: ["tienda"],
    ko: ["상점", "스토어"],
    pt: ["loja"],
    tl: ["tindahan"],
    vi: ["cửa hàng", "cua hang"],
    "zh-CN": ["商店"],
  },
  stream: {
    es: ["transmitir", "stream"],
    ko: ["스트림", "방송"],
    pt: ["transmitir", "stream"],
    tl: ["stream"],
    vi: ["phát trực tiếp", "phat truc tiep"],
    "zh-CN": ["直播"],
  },
  task: {
    es: ["tarea"],
    ko: ["작업"],
    pt: ["tarefa"],
    tl: ["gawain"],
    vi: ["nhiệm vụ", "nhiem vu"],
    "zh-CN": ["任务"],
  },
  terminal: {
    es: ["terminal"],
    ko: ["터미널"],
    pt: ["terminal"],
    tl: ["terminal"],
    vi: ["terminal"],
    "zh-CN": ["终端"],
  },
  token: {
    es: ["token"],
    ko: ["토큰"],
    pt: ["token"],
    tl: ["token"],
    vi: ["token"],
    "zh-CN": ["代币", "令牌"],
  },
  todo: {
    es: ["todo", "pendiente", "tarea"],
    ko: ["할일"],
    pt: ["todo", "afazer"],
    tl: ["todo", "gawain"],
    vi: ["việc cần làm", "viec can lam"],
    "zh-CN": ["待办"],
  },
  transaction: {
    es: ["transaccion"],
    ko: ["거래"],
    pt: ["transacao"],
    tl: ["transaksyon"],
    vi: ["giao dịch", "giao dich"],
    "zh-CN": ["交易"],
  },
  travel: {
    es: ["viaje"],
    ko: ["여행"],
    pt: ["viagem"],
    tl: ["biyahe"],
    vi: ["du lịch", "du lich"],
    "zh-CN": ["旅行"],
  },
  trust: {
    es: ["confianza"],
    ko: ["신뢰"],
    pt: ["confianca"],
    tl: ["tiwala"],
    vi: ["tin cậy", "tin cay"],
    "zh-CN": ["信任"],
  },
  tunnel: {
    es: ["tunel"],
    ko: ["터널"],
    pt: ["tunel"],
    tl: ["tunnel"],
    vi: ["đường hầm", "duong ham"],
    "zh-CN": ["隧道"],
  },
  unfollow: {
    es: ["dejar de seguir"],
    ko: ["팔로우 해제"],
    pt: ["deixar de seguir"],
    tl: ["i-unfollow"],
    vi: ["bỏ theo dõi", "bo theo doi"],
    "zh-CN": ["取消关注"],
  },
  unmute: {
    es: ["quitar silencio"],
    ko: ["음소거 해제"],
    pt: ["ativar som"],
    tl: ["i-unmute"],
    vi: ["bật tiếng", "bat tieng"],
    "zh-CN": ["取消静音"],
  },
  update: {
    es: ["actualizar"],
    ko: ["업데이트"],
    pt: ["atualizar"],
    tl: ["i-update"],
    vi: ["cập nhật", "cap nhat"],
    "zh-CN": ["更新"],
  },
  upload: {
    es: ["subir", "cargar"],
    ko: ["업로드"],
    pt: ["enviar", "upload"],
    tl: ["i-upload"],
    vi: ["tải lên", "tai len"],
    "zh-CN": ["上传"],
  },
  user: {
    es: ["usuario"],
    ko: ["사용자"],
    pt: ["usuario"],
    tl: ["user", "gumagamit"],
    vi: ["người dùng", "nguoi dung"],
    "zh-CN": ["用户"],
  },
  video: {
    es: ["video"],
    ko: ["비디오", "영상"],
    pt: ["video"],
    tl: ["video"],
    vi: ["video"],
    "zh-CN": ["视频"],
  },
  vision: {
    es: ["vision"],
    ko: ["비전"],
    pt: ["visao"],
    tl: ["vision"],
    vi: ["thị giác", "thi giac"],
    "zh-CN": ["视觉"],
  },
  wallet: {
    es: ["billetera", "wallet"],
    ko: ["지갑"],
    pt: ["carteira", "wallet"],
    tl: ["wallet"],
    vi: ["ví", "vi"],
    "zh-CN": ["钱包"],
  },
  web: {
    es: ["web"],
    ko: ["웹"],
    pt: ["web"],
    tl: ["web"],
    vi: ["web"],
    "zh-CN": ["网页"],
  },
  workflow: {
    es: ["flujo de trabajo"],
    ko: ["워크플로"],
    pt: ["fluxo de trabalho"],
    tl: ["workflow"],
    vi: ["quy trình", "quy trinh"],
    "zh-CN": ["工作流"],
  },
  workspace: {
    es: ["espacio de trabajo"],
    ko: ["작업공간"],
    pt: ["workspace", "espaco de trabalho"],
    tl: ["workspace"],
    vi: ["không gian làm việc", "khong gian lam viec"],
    "zh-CN": ["工作区"],
  },
  write: {
    es: ["escribir"],
    ko: ["쓰기"],
    pt: ["escrever"],
    tl: ["isulat"],
    vi: ["viết", "viet"],
    "zh-CN": ["写入"],
  },
  zone: {
    es: ["zona"],
    ko: ["구역"],
    pt: ["zona"],
    tl: ["zone"],
    vi: ["vùng", "vung"],
    "zh-CN": ["区域"],
  },
};

const EXTRA_TOKEN_TRANSLATIONS = {
  active: {
    es: ["activo"],
    ko: ["활성"],
    pt: ["ativo"],
    tl: ["aktibo"],
    vi: ["đang hoạt động", "dang hoat dong"],
    "zh-CN": ["活跃"],
  },
  activity: {
    es: ["actividad"],
    ko: ["활동"],
    pt: ["atividade"],
    tl: ["aktibidad"],
    vi: ["hoạt động", "hoat dong"],
    "zh-CN": ["活动"],
  },
  adjust: {
    es: ["ajustar"],
    ko: ["조정"],
    pt: ["ajustar"],
    tl: ["ayusin"],
    vi: ["điều chỉnh", "dieu chinh"],
    "zh-CN": ["调整"],
  },
  answer: {
    es: ["responder", "respuesta"],
    ko: ["답변"],
    pt: ["responder", "resposta"],
    tl: ["sagot"],
    vi: ["trả lời", "tra loi"],
    "zh-CN": ["回答"],
  },
  blocker: {
    es: ["bloqueador"],
    ko: ["차단기"],
    pt: ["bloqueador"],
    tl: ["blocker"],
    vi: ["trình chặn", "trinh chan"],
    "zh-CN": ["拦截器"],
  },
  content: {
    es: ["contenido"],
    ko: ["콘텐츠", "내용"],
    pt: ["conteudo"],
    tl: ["nilalaman"],
    vi: ["nội dung", "noi dung"],
    "zh-CN": ["内容"],
  },
  customer: {
    es: ["cliente"],
    ko: ["고객"],
    pt: ["cliente"],
    tl: ["customer", "kustomer"],
    vi: ["khách hàng", "khach hang"],
    "zh-CN": ["客户"],
  },
  fulfill: {
    es: ["cumplir", "procesar"],
    ko: ["처리"],
    pt: ["processar"],
    tl: ["tuparin"],
    vi: ["hoàn tất", "hoan tat"],
    "zh-CN": ["履约"],
  },
  general: {
    es: ["general"],
    ko: ["일반"],
    pt: ["geral"],
    tl: ["pangkalahatan"],
    vi: ["chung"],
    "zh-CN": ["通用"],
  },
  handle: {
    es: ["manejar"],
    ko: ["처리"],
    pt: ["lidar"],
    tl: ["hawakan"],
    vi: ["xử lý", "xu ly"],
    "zh-CN": ["处理"],
  },
  identify: {
    es: ["identificar"],
    ko: ["식별"],
    pt: ["identificar"],
    tl: ["tukuyin"],
    vi: ["nhận dạng", "nhan dang"],
    "zh-CN": ["识别"],
  },
  inferred: {
    es: ["inferido"],
    ko: ["추론"],
    pt: ["inferido"],
    tl: ["hinula"],
    vi: ["suy luận", "suy luan"],
    "zh-CN": ["推断"],
  },
  management: {
    es: ["gestion"],
    ko: ["관리"],
    pt: ["gerenciamento"],
    tl: ["pamamahala"],
    vi: ["quản lý", "quan ly"],
    "zh-CN": ["管理"],
  },
  media: {
    es: ["multimedia"],
    ko: ["미디어"],
    pt: ["midia"],
    tl: ["media"],
    vi: ["đa phương tiện", "da phuong tien"],
    "zh-CN": ["媒体"],
  },
  object: {
    es: ["objeto"],
    ko: ["객체", "물체"],
    pt: ["objeto"],
    tl: ["bagay"],
    vi: ["đối tượng", "doi tuong"],
    "zh-CN": ["对象", "物体"],
  },
  operation: {
    es: ["operacion"],
    ko: ["작업"],
    pt: ["operacao"],
    tl: ["operasyon"],
    vi: ["thao tác", "thao tac"],
    "zh-CN": ["操作"],
  },
  resource: {
    es: ["recurso"],
    ko: ["리소스"],
    pt: ["recurso"],
    tl: ["resource"],
    vi: ["tài nguyên", "tai nguyen"],
    "zh-CN": ["资源"],
  },
  rule: {
    es: ["regla"],
    ko: ["규칙"],
    pt: ["regra"],
    tl: ["panuntunan"],
    vi: ["quy tắc", "quy tac"],
    "zh-CN": ["规则"],
  },
  server: {
    es: ["servidor"],
    ko: ["서버"],
    pt: ["servidor"],
    tl: ["server"],
    vi: ["máy chủ", "may chu"],
    "zh-CN": ["服务器"],
  },
  status: {
    es: ["estado"],
    ko: ["상태"],
    pt: ["status", "estado"],
    tl: ["status"],
    vi: ["trạng thái", "trang thai"],
    "zh-CN": ["状态"],
  },
  stock: {
    es: ["stock", "existencias"],
    ko: ["재고"],
    pt: ["estoque"],
    tl: ["stock"],
    vi: ["tồn kho", "ton kho"],
    "zh-CN": ["库存"],
  },
  tool: {
    es: ["herramienta"],
    ko: ["도구"],
    pt: ["ferramenta"],
    tl: ["tool", "kasangkapan"],
    vi: ["công cụ", "cong cu"],
    "zh-CN": ["工具"],
  },
  website: {
    es: ["sitio web"],
    ko: ["웹사이트"],
    pt: ["site"],
    tl: ["website"],
    vi: ["trang web"],
    "zh-CN": ["网站"],
  },
};

const STOPWORDS = new Set([
  "a",
  "about",
  "across",
  "after",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "current",
  "for",
  "from",
  "has",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "other",
  "per",
  "the",
  "this",
  "to",
  "use",
  "when",
  "with",
  "within",
]);

const audit = JSON.parse(
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts/audit-action-availability.mjs"), "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  ),
);

const existingActionKeywords = readJson(ACTION_KEYWORDS_PATH, {
  entries: {},
});
const contextKeywords = readJson(CONTEXT_KEYWORDS_PATH, {
  entries: {},
});
const actionsByStem = new Map();

for (const action of audit.actions) {
  const stem = actionNameToKeywordStem(action.name);
  if (!stem) continue;
  const record = actionsByStem.get(stem) ?? {
    names: new Set(),
    similes: new Set(),
    contexts: new Set(),
    descriptions: new Set(),
  };
  record.names.add(action.name);
  for (const simile of action.similes ?? []) record.similes.add(simile);
  for (const context of action.contexts ?? []) record.contexts.add(context);
  if (action.description) record.descriptions.add(action.description);
  if (action.descriptionCompressed) {
    record.descriptions.add(action.descriptionCompressed);
  }
  actionsByStem.set(stem, record);
}

const entries = {};
for (const [stem, record] of [...actionsByStem.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const key = `action.${stem}.request`;
  const existing = existingActionKeywords.entries?.[key] ?? {};
  const seedTerms = [
    ...arrayValue(existing.base),
    ...[...record.names].flatMap(identifierTermVariants),
    ...[...record.similes].flatMap(identifierTermVariants),
  ];

  for (const context of record.contexts) {
    for (const name of record.names) {
      seedTerms.push(`${context} ${identifierToPhrase(name)}`);
    }
  }

  for (const description of record.descriptions) {
    seedTerms.push(...extractDescriptionTerms(description));
  }

  const base = limitTerms(dedupeTerms(seedTerms), BASE_LIMIT);
  const localeEntries = {};
  for (const locale of SUPPORTED_LOCALES) {
    const terms = [
      ...contextLocaleTerms(record.contexts, locale),
      ...buildLocaleTerms({
        base,
        locale,
        names: record.names,
        similes: record.similes,
        descriptions: record.descriptions,
      }),
    ];
    const deduped = limitTerms(dedupeTerms(terms), LOCALE_LIMIT);
    localeEntries[locale] =
      deduped.length > 0 ? deduped : [...(FALLBACK_LOCALE_TERMS[locale] ?? [])];
  }

  entries[key] = {
    base,
    ...localeEntries,
  };
}

const output = {
  $schema: "./keywords.schema.json",
  locales: SUPPORTED_LOCALES,
  entries,
};

writeFileSync(ACTION_KEYWORDS_PATH, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Generated ${Object.keys(entries).length} action keyword entries at ${ACTION_KEYWORDS_PATH}`,
);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
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

function identifierTermVariants(identifier) {
  const phrase = identifierToPhrase(identifier);
  if (!phrase) return [];
  const snake = phrase.replace(/\s+/g, "_");
  return phrase === snake ? [phrase] : [phrase, snake];
}

function identifierToPhrase(identifier) {
  return String(identifier ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractDescriptionTerms(description) {
  const tokens = tokenize(description).filter(
    (token) =>
      !STOPWORDS.has(token) &&
      (token.length >= 4 || hasTokenTranslations(token)),
  );
  const terms = [];
  for (const token of tokens) {
    terms.push(token);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (hasTokenTranslations(left) || hasTokenTranslations(right)) {
      terms.push(`${left} ${right}`);
    }
  }
  return terms.slice(0, 48);
}

function tokenize(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function contextLocaleTerms(contexts, locale) {
  const terms = [];
  for (const context of contexts) {
    const prefix = `contextSignal.${context}.`;
    for (const [key, entry] of Object.entries(contextKeywords.entries ?? {})) {
      if (!key.startsWith(prefix)) continue;
      terms.push(...arrayValue(entry[locale]));
    }
  }
  return terms;
}

function buildLocaleTerms({ base, locale, names, similes, descriptions }) {
  const terms = [];
  for (const identifier of [...names, ...similes]) {
    terms.push(...translatePhrase(identifierToPhrase(identifier), locale));
  }
  for (const term of base.slice(0, 64)) {
    terms.push(...translatePhrase(term, locale));
  }
  for (const description of descriptions) {
    for (const token of extractDescriptionTerms(description)) {
      terms.push(...translatePhrase(token, locale));
    }
  }
  terms.push(...(FALLBACK_LOCALE_TERMS[locale] ?? []));
  return terms;
}

function translatePhrase(phrase, locale) {
  const tokens = tokenize(phrase);
  if (tokens.length === 0) return [];

  const translatedTokens = [];
  let changed = false;
  for (const token of tokens) {
    const translations = tokenTranslations(token, locale);
    if (translations?.length) {
      translatedTokens.push(translations[0]);
      changed = true;
    } else if (PRESERVE_UNTRANSLATED_TOKENS.has(token)) {
      translatedTokens.push(token);
    }
  }

  const terms = [];
  if (changed && translatedTokens.length > 0) {
    terms.push(translatedTokens.join(" "));
  }

  for (const token of tokens) {
    const translations = tokenTranslations(token, locale);
    if (translations?.length) {
      terms.push(...translations);
    }
  }

  return terms;
}

function hasTokenTranslations(token) {
  return SUPPORTED_LOCALES.some(
    (locale) => tokenTranslations(token, locale).length > 0,
  );
}

function tokenTranslations(token, locale) {
  const exact =
    TOKEN_TRANSLATIONS[token]?.[locale] ??
    EXTRA_TOKEN_TRANSLATIONS[token]?.[locale];
  if (exact?.length) return exact;

  const singular = singularizeToken(token);
  if (singular !== token) {
    return (
      TOKEN_TRANSLATIONS[singular]?.[locale] ??
      EXTRA_TOKEN_TRANSLATIONS[singular]?.[locale] ??
      []
    );
  }
  return [];
}

function singularizeToken(token) {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function dedupeTerms(terms) {
  const seen = new Set();
  const result = [];
  for (const term of terms) {
    const normalized = normalizeTerm(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(String(term).trim());
  }
  return result;
}

function limitTerms(terms, limit) {
  return terms
    .filter((term) => term.length <= 96)
    .sort((left, right) => scoreTerm(right) - scoreTerm(left))
    .slice(0, limit)
    .sort((left, right) =>
      normalizeTerm(left).localeCompare(normalizeTerm(right)),
    );
}

function scoreTerm(term) {
  const normalized = normalizeTerm(term);
  let score = 0;
  if (normalized.includes(" ")) score += 5;
  if (/^[\p{Letter}\p{Number}\s-]+$/u.test(normalized)) score += 2;
  score -= Math.max(0, normalized.length - 48) / 8;
  return score;
}

function normalizeTerm(term) {
  return String(term ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
