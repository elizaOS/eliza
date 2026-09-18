/** Authored multilingual capability keywords. Edit this table directly; builds never rewrite it. */
export const VALIDATION_KEYWORD_LOCALES = [
  "es",
  "ko",
  "pt",
  "tl",
  "vi",
  "zh-CN",
] as const;

export type ValidationKeywordLocale =
  (typeof VALIDATION_KEYWORD_LOCALES)[number];

type ValidationKeywordDoc = {
  base?: string;
  locales?: Partial<Record<ValidationKeywordLocale, string>>;
};

type ValidationKeywordTree = {
  [key: string]: ValidationKeywordTree | ValidationKeywordDoc;
};

export const VALIDATION_KEYWORD_DOCS = {
  action: {
    message: {
      request: {
        base: "add a channel\nchannel structure\ncode-ops\ncode-ops template\ncreate a channel\ncreate category\ncreate channel\ndelete channel\ndiscord template\nguild management\nguild template\nmake a channel\nmanage server\nnew channel\nserver management\nserver role\nserver setup\nserver structure\nserver template\nserver templates\nset up channels\ntemplate to this server\nadd remove\narchive message\narchive trash\nasks draft\nasks send\nautomation message\nblock sender\nblock target\ncalendar message\ncheck in draft\ncheck message\ncompose draft\ncompose followup\ncompose message\ncompose reply\nconfirm and send\nconfirmed message\nconnectors message\ncontact chosen\ncontacts message\ncross channel search\ndefer send\ndirect message\ndispatch draft\ndocuments message\ndraft follow\ndraft message reply\ndraft policy\ndraft reply\ndrafts reply\nemail finance\nemail message\nemail sarah\nexisting message\nfind message\nfollow check\nfollowup draft\ngate send\nhints draft\ninbox everything\ninbox needs\nlabel mute\nlast email\nlatest email\nlist messages\nlist unread\nmark read\nmessage contact\nmessage known\nmessage latest\nmessage reply\nmessage sender\nmessage step\nmessage user\nmessaging message\nmute unsubscribe\none shot reply\nonly list\noutbound message\npass message\nprioritize messages\nquick reply\nrank inbox\nread label\nread only\nread unread\nrecency user\nreply existing\nreply inbox\nreply including\nreply message\nreply only\nreply target\nreply then\nreply to message\nreply worthy\nrequests message\nrespond reply\nscan messages\nschedule send\nsearch chats\nsearch email\nsearch inbox\nsend later\nsend respond\nsender archive\nshow unread across\nsingle message\nstep user\ntag message\ntarget message\ntasks message\nunread add\nunsubscribe block\nuser asks\nwhat inbox",
        locales: {
          es: "agregar eliminar\narchivar mensaje\nautomatizacion mensaje\nbandeja de entrada\nbandeja de entrada listar\nborrador enviar\nborrador mensaje responder\nborrador responder\nborrador seguir\nbuscar bandeja de entrada\nbuscar chat\nbuscar correo\nbuscar mensaje\ncalendario mensaje\nconector mensaje\ncontacto mensaje\ncontenido enviar\ncorreo mensaje\ncrear borrador\ncrear enviar\ncuenta conectada\ndocumento mensaje\nenviar correo\nenviar enviar\nfecha limite\nflujo de trabajo\nguardar notas\nlistar mensaje\nmensaje archivar\nmensaje borrador responder\nmensaje buscar\nmensaje contacto\nmensaje enviar\nmensaje enviar solicitud\nmensaje mensaje\nmensaje responder\nmensaje usuario\npreguntar borrador\npreguntar enviar\nprogramar borrador\nprogramar enviar\nredactar correo\nresponder enviar\nresponder mensaje\nrevisar borrador\nrevisar mensaje\nseguir revisar\nusuario preguntar",
          ko: "검색 메시지\n검색 받은편지함\n검색 이메일\n검색 채팅\n계정 연결\n답장 메시지\n답장 보내기\n메시지 검색\n메시지 답장\n메시지 메시지\n메시지 보관\n메시지 보내기\n메시지 보내기 요청\n메시지 사용자\n메시지 연락처\n메시지 초안\n메시지 초안 답장\n메일 보내기\n목록 메시지\n문서 메시지\n받은편지함 목록\n보관 메시지\n보내기 보내기\n사용자 질문\n생성 보내기\n생성 초안\n연락처 메시지\n예약 보내기\n예약 초안\n이메일 메시지\n자동화 메시지\n질문 보내기\n질문 초안\n찾기 메시지\n초안 답장\n초안 메시지 답장\n초안 보내기\n초안 팔로우\n추가 제거\n캘린더 메시지\n커넥터 메시지\n콘텐츠 보내기\n파일 내용\n팔로우 확인\n할 일\n확인 메시지\n확인 초안\n후속 조치",
          pt: "adicionar remover\nagendar enviar\nagendar rascunho\narquivar mensagem\nautomacao mensagem\nbuscar caixa de entrada\nbuscar chat\nbuscar email\nbuscar mensagem\ncaixa de entrada\ncaixa de entrada listar\ncalendario mensagem\nconector mensagem\nconta conectada\ncontato mensagem\nconteudo enviar\ncriar enviar\ncriar rascunho\ndocumento mensagem\nemail mensagem\nencontrar mensagem\nenviar email\nenviar enviar\nfluxo de trabalho\nlistar mensagem\nmensagem arquivar\nmensagem buscar\nmensagem contato\nmensagem enviar\nmensagem enviar solicitacao\nmensagem mensagem\nmensagem rascunho\nmensagem rascunho responder\nmensagem responder\nmensagem usuario\nperguntar enviar\nperguntar rascunho\nrascunho enviar\nrascunho mensagem responder\nrascunho responder\nrascunho seguir\nresponder enviar\nresponder mensagem\nsalvar notas\nseguir verificar\nusuario perguntar\nverificar mensagem\nverificar rascunho",
          tl: "account connection\nautomation mensahe\nconnector mensahe\ncontact mensahe\ndokumento mensahe\ndraft ipadala\ndraft mensahe sagot\ndraft sagot\ndraft sundan\nemail mensahe\nfollow up\ngumawa draft\ngumawa ipadala\ngumawa ng email\nhanapin mensahe\ni-archive mensahe\ni-schedule draft\ni-schedule ipadala\nidagdag alisin\nilista mensahe\ninbox ilista\nipadala ipadala\nkalendaryo mensahe\nmaghanap chat\nmaghanap email\nmaghanap inbox\nmaghanap mensahe\nmagpadala ng email\nmagtanong draft\nmagtanong ipadala\nmensahe contact\nmensahe draft\nmensahe draft sagot\nmensahe i-archive\nmensahe ipadala\nmensahe ipadala kahilingan\nmensahe maghanap\nmensahe mensahe\nmensahe sagot\nmensahe user\nnilalaman ipadala\nnilalaman ng file\nsagot ipadala\nsagot mensahe\nsundan suriin\nsuriin draft\nsuriin mensahe\nuser magtanong",
          vi: "ban nhap\nbản nháp\nghi chu\nghi chú\ngửi email\nhop thu\nhộp thư\nhộp thư liệt kê\nket noi\nkết nối\nkich hoat\nkiểm tra bản nháp\nlien he\nliên hệ\nliet ke\nliệt kê\nlưu ghi chú\nluu tru\nlưu trữ\nnhắc nhở\nquan he\nquan hệ\nquy trinh\nquy trình\ntac vu\ntác vụ\ntài khoản\ntai lieu\ntài liệu\ntạo bản nháp\ntich hop\ntích hợp\ntin nhan\ntin nhắn\ntin nhắn bản nháp trả lời\ntin nhắn gửi\ntin nhắn gửi yêu cầu\ntin nhắn lưu trữ\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "discord 邮件\ntelegram 消息\n关注 检查\n内容 发送\n列出 消息\n创建 发送\n创建 草稿\n发送 telegram\n发送 发送\n回复 发送\n回复 消息\n安排 发送\n安排 草稿\n归档 消息\n搜索 收件箱\n搜索 消息\n搜索 聊天\n搜索 邮件\n收件箱 列出\n文档 消息\n日历 消息\n查找 消息\n检查 消息\n检查 草稿\n消息 内容\n消息 发送\n消息 发送 请求\n消息 回复\n消息 归档\n消息 搜索\n消息 消息\n消息 用户\n消息 联系人\n消息 草稿\n消息 草稿 回复\n添加 移除\n用户 询问\n联系人 消息\n自动化 消息\n草稿 关注\n草稿 发送\n草稿 回复\n草稿 消息 回复\n询问 发送\n询问 草稿\n连接器 消息\n邮件\n邮件 消息",
        },
      },
    },
    activatePluginIfReady: {
      request: {
        base: "activate\nactivate plugin\nactivate plugin if ready\nactivate_plugin_if_ready\nactivates\nactivates plugin\nconfig\nconfig keys\nelse\nenable plugin if configured\nenable_plugin_if_configured\nkeys\nkeys present\nmissing\nmissing keys\notherwise\nplugin\nplugin required\npresent\nregister plugin\nregister_plugin\nreports\nrequired\nreturn\nsatisfied",
        locales: {
          es: "accion\nactivar\nactivar plugin\nclave\ncomplemento\nherramienta\nplugin\nsolicitud\ntecla",
          ko: "도구\n요청\n작업\n키\n플러그인\n활성화\n활성화 플러그인",
          pt: "acao\nativar\nativar plugin\nchave\nferramenta\nplugin\nsolicitacao\ntecla",
          tl: "aksyon\ni-enable\ni-enable plugin\nkahilingan\nkasangkapan\nkey\nplugin",
          vi: "bat\nbật\nbật plugin\ncong cu\ncông cụ\nhanh dong\nhành động\nkhoa\nkhóa\nphim\nphím\nplugin\nyeu cau\nyêu cầu",
          "zh-CN": "启用\n启用 插件\n密钥\n工具\n插件\n操作\n请求\n键",
        },
      },
    },
    agentSwitch: {
      request: {
        base: "addresses\nadmin agent switch\nagent\nagent dedicated\nagent profile\nagent switch\nagent trusted\nagent_switch\nallowed\napp\napp different\napp saved\napp that\nbackend\nchange agent\nchange_agent\ncloud\ncloud agent\nconnect agent\nconnect_agent\ndedicated\ndifferent\neliza\ngeneral agent switch\nlabel\nlive\nlive app\nlocal\nlocal agent\npage\npage reload\nprofile\nprofile local\nprofile repoint\nprofile without\nprofiles\nrefuses\nreload\nremote\nremote profiles\nrepoint\nrepoint app\nrepoints\nruntime\nruntime agent\nruntime profile\nsaved\nsettings agent switch\nswitch\nswitch agent\nswitch app\nswitch backend\nswitch profile\nswitch runtime\nswitch to agent\nswitch_agent\nswitch_backend\nswitch_runtime\nswitch_to_agent\ntailscale\nthat\nthat profile\ntrusted\nunknown\nuntrusted\nuse agent\nuse runtime\nuse_agent\nuse_runtime\nwhere\nwithout\nwithout page",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrador agente\nagente\nagente perfil\najustes\naplicacion\napp\nchat general\nconectar\nconectar agente\nconfiguracion\nconfiguracion agente\nconversacion\ndueño\ngeneral\ngeneral agente\nhablar\nherramienta\nmodelo\npagina\nperfil\npermisos\npolitica\npreferencias\nrespuesta\nroles\nsolicitud",
          ko: "관리자\n관리자 에이전트\n구성\n권한\n답변\n도구\n말하기\n모델 설정\n설정\n설정 에이전트\n소유자\n앱\n에이전트\n에이전트 프로필\n역할\n연결\n연결 에이전트\n요청\n일반\n일반 대화\n일반 에이전트\n작업\n정책\n채팅\n토글\n페이지\n프로필\n환경설정",
          pt: "acao\nadministrador\nadministrador agente\nagente\nagente perfil\nalternar\naplicativo\napp\nchat geral\nconectar\nconectar agente\nconfiguracao\nconfiguracoes\nconfiguracoes agente\nconversa\ndono\nfalar\nferramenta\nfuncoes\ngeral\ngeral agente\nmodelo\npagina\nperfil\npermissoes\npolitica\npreferencias\nresposta\nsolicitacao",
          tl: "admin\nadmin agent\nagent\nagent profile\naksyon\napp\nconfiguration\ngeneral chat\nikonekta\nikonekta agent\nkahilingan\nkasangkapan\nmakipag-usap\nmay ari\nmodel settings\npahina\npahintulot\npangkalahatan\npangkalahatan agent\npatakaran\npreferences\nprofile\nrole\nsagot\nsettings\nsettings agent\ntoggle\nusap",
          vi: "cai dat\ncài đặt\ncài đặt tác tử\ncấu hình\nchu so huu\nchủ sở hữu\nchung\nchung tác tử\ncong cu\ncông cụ\nhanh dong\nhành động\nho so\nhồ sơ\nket noi\nkết nối\nkết nối tác tử\nnói chuyện\nquan tri\nquản trị\nquản trị tác tử\nquyen\nquyền\ntac tu\ntác tử\ntác tử hồ sơ\ntra loi\ntrả lời\ntrang\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 资料\n偏好\n回复\n回答\n对话\n工具\n应用\n开关\n所有者\n操作\n普通聊天\n智能体\n权限\n模型设置\n策略\n管理员\n管理员 代理\n角色\n设置\n设置 代理\n请求\n资料\n连接\n连接 代理\n通用\n通用 代理\n配置\n页面",
        },
      },
    },
    alarm: {
      request: {
        base: "action\naction parameter\nalarm\nalarm cancel\nalarm list\nalarms\nalarms pass\nalarms unuser\ncancel\ncancel alarm macos\ncancel list\ncancel macos alarm\ncancel remove\ncancel_alarm_macos\ncancel_macos_alarm\ncenter\ncreate mac alarm\ncreate_mac_alarm\ninferred\nlist\nlist alarms macos\nlist macos alarms\nlist show\nlist unuser\nlist_alarms_macos\nlist_macos_alarms\nmanage\nmanage native\nnative\nnative alarms\nnotification\nomitted\noperation\noperation structured\notherwise\nparameter\nparams\npass\npass operation\npayload\npending\npending alarms\nremove\nremove mac alarm\nremove scheduled\nremove_mac_alarm\nschedule\nschedule alarm\nschedule macos alarm\nschedule_macos_alarm\nscheduled\nscheduled alarm\nset a mac alarm\nset alarm macos\nset_a_mac_alarm\nset_alarm_macos\nshow\nshow pending alarms\nshow_pending_alarms\nstructured\nstructured action\nsubactions\nsubactions schedule\nunuser\nwake me up on mac\nwake_me_up_on_mac",
        locales: {
          es: "accion\nadministrar\nagendar\nalarma\nalarma listar\ncrear\ncrear alarma\neliminar\neliminar alarma\ngestionar\nherramienta\ninferido\nlistar\nlistar alarma\nmostrar\noperacion\nprogramar\nprogramar alarma\nquitar\nsolicitud",
          ko: "관리\n도구\n목록\n목록 알람\n생성\n생성 알람\n알람\n알람 목록\n예약\n예약 알람\n요청\n일정\n작업\n제거\n제거 알람\n추론",
          pt: "acao\nagendar\nagendar alarme\nalarme\nalarme listar\ncriar\ncriar alarme\nferramenta\ngerenciar\ninferido\nlistar\nlistar alarme\nmostrar\noperacao\nremover\nremover alarme\nsolicitacao",
          tl: "aksyon\nalarm\nalarm ilista\nalisin\nalisin alarm\ngumawa\ngumawa alarm\nhinula\ni-schedule\ni-schedule alarm\nilista\nilista alarm\nkahilingan\nkasangkapan\noperasyon\npamahalaan",
          vi: "bao thuc\nbáo thức\nbáo thức liệt kê\ncong cu\ncông cụ\ngo\ngỡ\ngỡ báo thức\nhanh dong\nhành động\nlen lich\nlên lịch\nlên lịch báo thức\nliet ke\nliệt kê\nliệt kê báo thức\nquan ly\nquản lý\nsuy luan\nsuy luận\ntao\ntạo\ntạo báo thức\nthao tac\nthao tác\nyeu cau\nyêu cầu",
          "zh-CN":
            "列出\n列出 闹钟\n创建\n创建 闹钟\n安排\n安排 闹钟\n工具\n推断\n操作\n移除\n移除 闹钟\n管理\n请求\n闹钟\n闹钟 列出",
        },
      },
    },
    app: {
      request: {
        base: "absolute\naction\nagent\nagent verifies\napp\napp control\napp list\napp page\napp runs\napp_control\napps\napps launch\nasks\nautomation app\nbuild app\nbuild web app\nbuilds web\ncancel\nclose app\ncode app\ncoding\ncoding agent\ncontrol\ncreate\ncreate app\ncreate builds\ncreate create\ncreate html app\ncreate scaffolds\ndevice\ndirectory\ndispatches\nedit\nexisting\nflow\nfolder\nfolder create\ngeneral app\nget installed apps\nhost web app\ninstalled\ninstalled apps\nlaunch\nlaunch app\nlaunches\nlink publish\nlist\nlist apps\nlist installed apps\nlist load\nlist running apps\nload\nmake website\nmanage\nmanage apps\nmanage_apps\nmode\nmulti\nnew app\noptionally\npage site\npublish target\npublish web page\nregistered\nregisters\nrelaunch\nrelaunch app\nrelaunch list\nrelaunch stop\nrestart app\nresult\nrun app\nrunning\nrunning apps\nruns\nruns coding\nscaffolds\nscaffolds app\nsearches\nsettings app\nshows\nstart app\nstarts\nstop\nstop app\nstop list\nstops\ntemplate\nthat\nthen\nturn\nunified\nverifies\nverify\nweb app\nwithout",
        locales: {
          es: "activar\nadministrar\najustes\naplicacion\naplicacion controlar\naplicacion ejecutar\naplicacion listar\naplicacion pagina\napp\nautomatizacion\nautomatizacion aplicacion\nchat general\ncodigo\ncodigo aplicacion\nconfiguracion\ncontrolar\nconversacion\ncrear aplicacion\ncrear crear\ncrear html aplicacion\ncron\ndepurar\ndetener aplicacion\ndetener listar\ndisparador\nejecutar\nejecutar aplicacion\nflujo de trabajo\ngeneral aplicacion\ngestionar\ngestionar aplicacion\nhablar\nimplementar\nlistar\nlistar aplicacion\nmodelo\nmonitor\nmostrar\nobtener\nobtener aplicacion\npreferencias\nprogramacion\nprueba\npublicar web pagina\nrepositorio\nrespuesta\nsitio web\nweb aplicacion",
          ko: "가져오기\n가져오기 앱\n게시 웹 페이지\n관리\n관리 앱\n구성\n구현\n답변\n디버그\n말하기\n모니터\n모델 설정\n목록\n목록 앱\n생성\n생성 html 앱\n생성 생성\n생성 앱\n설정\n실행\n실행 앱\n앱\n앱 목록\n앱 실행\n앱 제어\n앱 페이지\n워크플로\n웹\n웹 앱\n웹사이트\n일반 대화\n일반 앱\n자동화\n자동화 앱\n저장소\n제어\n중지\n중지 목록\n중지 앱\n채팅\n코드\n코드 앱\n크론\n테스트\n토글\n트리거\n프로그래밍\n환경설정",
          pt: "alternar\naplicativo\naplicativo controlar\naplicativo executar\naplicativo listar\naplicativo pagina\napp\nautomacao\nautomacao aplicativo\nchat geral\ncodigo\ncodigo aplicativo\nconfiguracao\nconfiguracoes\ncontrolar\nconversa\ncriar\ncriar aplicativo\ncriar criar\ncriar html aplicativo\ncron\ndepurar\nexecutar\nexecutar aplicativo\nfalar\nfluxo de trabalho\ngatilho\ngeral aplicativo\ngerenciar\ngerenciar aplicativo\nimplementar\nlistar\nlistar aplicativo\nmodelo\nmonitor\nmostrar\nobter\nobter aplicativo\nparar\nparar aplicativo\nparar listar\npreferencias\nprogramacao\npublicar web pagina\nrepositorio\nresposta\nteste\nweb aplicativo",
          tl: "app\napp ilista\napp kontrol\napp pahina\napp patakbuhin\nautomation\nautomation app\ncode\ncode app\nconfiguration\ncron\ndebug\ngeneral chat\ngumawa\ngumawa app\ngumawa gumawa\ngumawa html app\ni-publish web pahina\nilista\nilista app\nipatupad\nitigil\nitigil app\nitigil ilista\nkontrol\nkunin\nkunin app\nmakipag-usap\nmodel settings\nmonitor\npamahalaan\npamahalaan app\npangkalahatan app\npatakbuhin\npatakbuhin app\npreferences\nprogramming\nrepo\nsagot\nsettings\ntest\ntoggle\ntrigger\nusap\nweb\nweb app\nwebsite\nworkflow",
          vi: "cai dat\ncài đặt\ncấu hình\nchạy ứng dụng\ndieu khien\nđiều khiển\ndừng ứng dụng\nhanh dong\nhành động\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nlấy ứng dụng\nliet ke\nliệt kê\nliệt kê ứng dụng\nnói chuyện\nquan ly\nquản lý\nquản lý ứng dụng\nquy trinh\nquy trình\ntac tu\ntác tử\ntạo html ứng dụng\ntạo ứng dụng\ntra loi\ntrả lời\ntrang web\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng chạy\nứng dụng điều khiển\nứng dụng liệt kê\nứng dụng trang\nweb ứng dụng\nxuat ban\nxuất bản\nxuất bản web trang",
          "zh-CN":
            "仓库\n代码\n代码 应用\n偏好\n停止\n停止 列出\n停止 应用\n列出\n列出 应用\n创建\n创建 html 应用\n创建 创建\n创建 应用\n发布 网页 页面\n回复\n回答\n定时\n实现\n对话\n工作流\n应用\n应用 列出\n应用 控制\n应用 运行\n应用 页面\n开关\n控制\n普通聊天\n模型设置\n测试\n监控\n管理\n管理 应用\n编程\n网站\n网页\n网页 应用\n自动化\n自动化 应用\n获取\n获取 应用\n触发器\n设置\n调试\n运行\n运行 应用\n通用 应用\n配置",
        },
      },
    },
    attachment: {
      request: {
        base: "action\naction read\naction save\nattachment\nattachment content\nattachment operations\nattachments\nattachments link\ncontent\ncontent document\ncontent media\ndescriptions\ndescriptions action\ndocument\ndocument store\ndocuments attachment\nextracted\nfiles attachment\ngeneral attachment\ninspect attachment\ninspect_attachment\nlink\nmedia\nmedia attachment\nmedia descriptions\nmessaging attachment\nopen attachment\nopen url\nopen_attachment\nopen_url\noperations\noperations action\npage\npage content\npreviews\nread\nread read\nread recent\nread url\nread webpage\nread_url\nread_webpage\nreadable\nreadable attachment\nrecent\nrecent attachments\nsave\nsave attachment as document\nsave document\nsave_attachment_as_document\nstore\nstore readable\ntext\ntranscripts\ntranscripts page\nusing\nweb attachment",
        locales: {
          es: "abrir\nabrir adjunto\nabrir url\naccion\naccion leer\nadjunto\nadjunto contenido\nadjunto documento\nadjunto operacion\narchivo\narchivo adjunto\narchivos\naudio\nbuscar web\ncaptura\ncarpeta\nchat general\ncontenido\ncontenido documento\ncontenido multimedia\nconversacion\ndirectorio\ndocumento\ndocumento adjunto\ndocumento tienda\ndocumentos\ngeneral adjunto\nguardar notas\nhablar\nimagen\ninformacion actual\ninternet\nleer\nleer archivo\nleer leer\nleer url\nmultimedia\nmultimedia adjunto\nnotas\noperacion\noperacion accion\npagina contenido\nrespuesta\ntranscripcion\nultimo\nvideo\nweb\nweb adjunto",
          ko: "url 열기\n노트\n답변\n디렉터리\n말하기\n문서\n문서 상점\n문서 첨부파일\n미디어\n미디어 첨부파일\n비디오\n스크린샷\n열기\n열기 url\n열기 첨부파일\n오디오\n웹\n웹 검색\n웹 첨부파일\n이미지\n인터넷\n일반 대화\n일반 첨부파일\n읽기\n읽기 url\n읽기 읽기\n작업\n작업 읽기\n작업 작업\n저장\n전사\n채팅\n첨부파일\n첨부파일 문서\n첨부파일 작업\n첨부파일 콘텐츠\n최신\n최신 정보\n콘텐츠\n콘텐츠 문서\n콘텐츠 미디어\n파일\n파일 내용\n파일 쓰기\n파일 읽기\n파일 첨부파일\n페이지 콘텐츠\n폴더",
          pt: "abrir\nabrir anexo\nabrir url\nacao\nacao ler\nanexo\nanexo conteudo\nanexo documento\nanexo operacao\narquivo\narquivo anexo\narquivos\naudio\nbuscar na web\ncaptura\nchat geral\nconteudo\nconteudo documento\nconteudo midia\nconversa\ndiretorio\ndocumento\ndocumento anexo\ndocumento loja\ndocumentos\nfalar\ngeral anexo\nimagem\ninformacao atual\ninternet\nler\nler arquivo\nler ler\nler url\nloja\nmidia\nmidia anexo\nnotas\noperacao\noperacao acao\npagina conteudo\npasta\nresposta\nsalvar notas\ntranscricao\nvideo\nweb\nweb anexo",
          tl: "aksyon\naksyon basahin\nattachment\nattachment dokumento\nattachment nilalaman\nattachment operasyon\naudio\nbasahin\nbasahin basahin\nbasahin file\nbasahin url\nbuksan\nbuksan attachment\nbuksan url\ndirectory\ndokumento\ndokumento attachment\ndokumento tindahan\nfile\nfile attachment\nfiles\nfolder\ngeneral chat\ni-save\ninternet\nkasalukuyang impormasyon\nlarawan\nmakipag-usap\nmedia\nmedia attachment\nnilalaman\nnilalaman dokumento\nnilalaman media\nnilalaman ng file\nnotes\nopen url\noperasyon\noperasyon aksyon\npahina nilalaman\npangkalahatan attachment\nsagot\nscreenshot\nsearch web\ntranscript\nusap\nvideo\nweb\nweb attachment",
          vi: "âm thanh\nchung tệp đính kèm\ncua hang\ncửa hàng\nda phuong tien\nđa phương tiện\nđa phương tiện tệp đính kèm\ndoc tep\nđọc tệp\nđọc url\nghi chu\nghi chú\nhanh dong\nhành động\nhành động đọc\nhinh anh\nhình ảnh\nlưu ghi chú\nmở tệp đính kèm\nmở url\nnói chuyện\nnoi dung\nnội dung\nnội dung đa phương tiện\nnội dung tài liệu\ntai lieu\ntài liệu\ntài liệu cửa hàng\ntài liệu tệp đính kèm\ntep dinh kem\ntệp đính kèm\ntệp đính kèm nội dung\ntệp đính kèm tài liệu\ntệp đính kèm thao tác\ntệp tệp đính kèm\nthao tac\nthao tác\nthao tác hành động\nthong tin hien tai\nthông tin hiện tại\nthu muc\nthư mục\ntìm web\ntra loi\ntrả lời\ntrang nội dung\ntro chuyen\ntrò chuyện",
          "zh-CN":
            "互联网\n保存笔记\n内容\n内容 媒体\n内容 文档\n最新信息\n写文件\n商店\n回复\n回答\n图片\n媒体\n媒体 附件\n对话\n截图\n打开\n打开 url\n打开 附件\n打开网址\n操作\n操作 操作\n操作 读取\n文件\n文件 附件\n文件内容\n文件夹\n文档\n文档 商店\n文档 附件\n普通聊天\n目录\n视频\n笔记\n网络\n网页 附件\n网页搜索\n读取\n读取 url\n读取 读取\n读取文件\n转录\n通用 附件\n附件\n附件 内容\n附件 操作\n附件 文档\n音频\n页面 内容",
        },
      },
    },
    attachToChat: {
      request: {
        base: "active\nactive conversation\nadd to chat\nadd_to_chat\nagent_internal attach to chat\nattach\nattach knowledge\nattach to chat\nattach_knowledge\nattach_to_chat\ncaller\ncaller read\nchat\nchat sha256\nconversation\nconversation user\ndocuments attach to chat\nfiles attach to chat\ninline\ninsert attachment\ninsert_attachment\nitem\nitem media\nknowledge\nknowledge attach to chat\nknowledge item\nmedia\nmedia active\nmedia attach to chat\nmedia chat\nmedia reference\nread\nreference\nrefuses\nscope\nsees\nsha256\nsha256 media\nshow file\nshow_file\nstored\nstored knowledge\ntakes\nuser\nuser sees\nwalled",
        locales: {
          es: "accion\nactivo\nadjunto\nagente\nagente chat\nagregar\nagregar chat\nanadir\narchivo\narchivo chat\narchivos\naudio\ncaptura\ncarpeta\nchat\nconocimiento\nconocimiento chat\nconversacion\ndirectorio\ndocumento\ndocumento chat\ndocumentos\nestado interno\ngestion interna\nguardar notas\nhechos guardados\nherramienta\nimagen\ninterno del agente\nleer\nleer archivo\nmultimedia\nmultimedia activo\nmultimedia chat\nnotas\nnotas guardadas\nrecordar\nsolicitud\ntranscripcion\nusuario\nvideo",
          ko: "검색\n내부 상태\n노트\n대화\n도구\n디렉터리\n문서\n문서 채팅\n미디어\n미디어 채팅\n미디어 활성\n비디오\n사용자\n스크린샷\n에이전트\n에이전트 내부\n에이전트 채팅\n오디오\n요청\n이미지\n읽기\n자체 관리\n작업\n저장\n저장된 노트\n저장된 사실\n전사\n지식\n지식 채팅\n채팅\n첨부파일\n추가\n추가 채팅\n파일\n파일 내용\n파일 쓰기\n파일 읽기\n파일 채팅\n폴더\n활성\n회상",
          pt: "acao\nadicionar\nadicionar chat\nagente\nagente chat\nanexo\narquivo\narquivo chat\narquivos\nativo\naudio\ncaptura\nchat\nconhecimento\nconhecimento chat\nconversa\ndiretorio\ndocumento\ndocumento chat\ndocumentos\nestado interno\nfatos salvos\nferramenta\ngestao interna\nimagem\ninterno do agente\nlembrar\nler\nler arquivo\nmidia\nmidia ativo\nmidia chat\nnotas\nnotas salvas\npasta\nsalvar notas\nsolicitacao\ntranscricao\nusuario\nvideo",
          tl: "agent\nagent chat\naksyon\naktibo\nalalahanin\nattachment\naudio\nbasahin\nbasahin file\nchat\ndirectory\ndokumento\ndokumento chat\nfile\nfile chat\nfiles\nfolder\ngumagamit\ni-save\nidagdag\nidagdag chat\ninternal ng agent\ninternal state\nkaalaman\nkaalaman chat\nkahilingan\nkasangkapan\nlarawan\nmedia\nmedia aktibo\nmedia chat\nnilalaman ng file\nnotes\nsariling pamamahala\nsaved facts\nsaved notes\nscreenshot\ntranscript\nusap\nuser\nvideo",
          vi: "âm thanh\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nđa phương tiện đang hoạt động\nđa phương tiện trò chuyện\ndang hoat dong\nđang hoạt động\ndoc tep\nđọc tệp\nghi chu\nghi chú\nghi chu da luu\nghi chú đã lưu\nhanh dong\nhành động\nhinh anh\nhình ảnh\nkien thuc\nkiến thức\nkiến thức trò chuyện\nlưu ghi chú\nnguoi dung\nngười dùng\nnhớ lại\nnoi bo tac tu\nnội bộ tác tử\ntac tu\ntác tử\ntác tử trò chuyện\ntai lieu\ntài liệu\ntài liệu trò chuyện\ntep\ntệp\ntep dinh kem\ntệp đính kèm\ntệp trò chuyện\nthêm trò chuyện\nthu muc\nthư mục\ntro chuyen\ntrò chuyện\ntu quan ly\ntự quản lý\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 聊天\n代理内部\n保存笔记\n内部状态\n写文件\n回忆\n图片\n媒体\n媒体 活跃\n媒体 聊天\n工具\n已保存事实\n已保存笔记\n截图\n操作\n文件\n文件 聊天\n文件内容\n文件夹\n文档\n文档 聊天\n智能体\n活跃\n添加\n添加 聊天\n用户\n目录\n知识\n知识 聊天\n视频\n笔记\n聊天\n自我管理\n语义搜索\n请求\n读取\n读取文件\n转录\n附件\n音频",
        },
      },
    },
    awaitChildAgentDecision: {
      request: {
        base: "agent\nagent emit\nagent next\nawait child agent decision\nawait sub agent decision\nawait_child_agent_decision\nawait_sub_agent_decision\nblock\nblock child\nblock on child decision\nblock_on_child_decision\nchannel\nchild\ncoding\ncoding agent\ndecision\nemit\nline\nnamed\nnext\ntimeout\nwait\nwait for child decision\nwait_for_child_decision",
        locales: {
          es: "accion\nagente\nbloquear\nherramienta\nsolicitud",
          ko: "도구\n에이전트\n요청\n작업\n차단",
          pt: "acao\nagente\nbloquear\nferramenta\nsolicitacao",
          tl: "agent\naksyon\ni-block\nkahilingan\nkasangkapan",
          vi: "chan\nchặn\ncong cu\ncông cụ\nhanh dong\nhành động\ntac tu\ntác tử\nyeu cau\nyêu cầu",
          "zh-CN": "代理\n工具\n操作\n智能体\n请求\n阻止",
        },
      },
    },
    awaitOauthCallback: {
      request: {
        base: "await\nawait oauth\nawait oauth bind\nawait oauth callback\nawait_oauth_bind\nawait_oauth_callback\ncallback\ndeliver\nintent\noauth\noauth callback\nresult\nwait\nwait for oauth callback\nwait oauth\nwait_for_oauth_callback",
        locales: {
          es: "accion\nautorizacion\nherramienta\noauth\nsolicitud",
          ko: "oauth\n도구\n요청\n인증\n작업",
          pt: "acao\nautorizacao\nferramenta\noauth\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan\noauth",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\noauth\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN": "oauth\n工具\n授权\n操作\n请求",
        },
      },
    },
    background: {
      request: {
        base: "animated\napp\napp background\naurora\nbackdrop\nbackground\nbigger\nbrighter\nchange\nchange background\nchange background color\nchange wallpaper\nchange_background\nchange_background_color\nchange_wallpaper\nchat\ncode background\ncolor\ndefault\ndescription\ndrives\nedit background\nedit_background\nevery\ngeneral background\ngenerate\ngenerate undo\ngenerated\nhome\nimage\nimage generate\nlast\nlava\nmedia background\nnebula\nplasma\npreset\nprogrammable\nrecolor\nrecolor app\nredo\nredo background\nredo background change\nredo wallpaper\nredo_background\nredo_background_change\nredo_wallpaper\nreset\nreset background\nreset wallpaper\nreset_background\nreset_wallpaper\nrestore\nrestore background\nrestore_background\nrevert\nrevert background\nrevert_background\nrun\nrun animated\nset background\nset background color\nset wallpaper\nset_background\nset_background_color\nset_wallpaper\nsettings background\nshader\nshader image\nshared\nslower\ntweak\nundid\nundo\nundo background\nundo background change\nundo wallpaper\nundo_background\nundo_background_change\nundo_wallpaper\nunified\nuploaded\nview\nwallpaper\nwallpaper run\nwaves\nbackground color\nbackground image\nbackground shader\nanimated background\nbackground change\nwallpaper change\nchange the background\nset the background\nundo the background\nundo that background\nredo the background\nreset the background\nrevert the background\nrevert the wallpaper\nrestore the background\ndefault background\nput the background back",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\napp\naudio\ncaptura\nchat\nchat general\ncodigo\nconfiguracion\nconversacion\ndepurar\neditar\nejecutar\nfoto\ngeneral\ngenerar\nhablar\nherramienta\nimagen\nimagen generar\nimplementar\nmodelo\nmultimedia\npreferencias\nprogramacion\nprueba\nrepositorio\nrespuesta\nsolicitud\ntranscripcion\nvideo\nfondo\nfondo de pantalla\ncolor de fondo\ndeshacer el fondo\nrestablecer el fondo",
          ko: "구성\n구현\n답변\n대화\n도구\n디버그\n말하기\n모델 설정\n미디어\n비디오\n사진\n생성\n설정\n스크린샷\n실행\n앱\n오디오\n요청\n이미지\n이미지 생성\n일반\n일반 대화\n작업\n저장소\n전사\n채팅\n코드\n테스트\n토글\n편집\n프로그래밍\n환경설정\n배경\n배경화면\n배경 색\n배경 되돌리기\n배경 초기화",
          pt: "acao\nalternar\naplicativo\napp\naudio\ncaptura\nchat\nchat geral\ncodigo\nconfiguracao\nconfiguracoes\nconversa\ndepurar\neditar\nexecutar\nfalar\nferramenta\nfoto\ngeral\ngerar\nimagem\nimagem gerar\nimplementar\nmidia\nmodelo\npreferencias\nprogramacao\nrepositorio\nresposta\nsolicitacao\nteste\ntranscricao\nvideo\nfundo\npapel de parede\nplano de fundo\ncor de fundo\ndesfazer o fundo\nredefinir o fundo",
          tl: "aksyon\napp\naudio\nbumuo\nchat\ncode\nconfiguration\ndebug\ngeneral chat\ni-edit\nipatupad\nkahilingan\nkasangkapan\nlarawan\nlarawan bumuo\nmakipag-usap\nmedia\nmodel settings\npangkalahatan\npatakbuhin\npreferences\nprogramming\nrepo\nsagot\nscreenshot\nsettings\ntest\ntoggle\ntranscript\nusap\nvideo\nbackground\nwallpaper\nkulay ng background\nibalik ang background\ni-reset ang background",
          vi: "âm thanh\nanh\nảnh\ncai dat\ncài đặt\ncấu hình\nchay\nchạy\nchinh sua\nchỉnh sửa\nchung\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nhanh dong\nhành động\nhinh anh\nhình ảnh\nhình ảnh tạo\nkho ma\nkho mã\nkiểm thử\nlap trinh\nlập trình\nma\nmã\nnói chuyện\ntao\ntạo\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nung dung\nứng dụng\nvideo\nyeu cau\nyêu cầu\nhình nền\nhinh nen\nnền\nmàu nền\nmau nen\nhoàn tác hình nền\nđặt lại hình nền",
          "zh-CN":
            "仓库\n代码\n偏好\n回复\n回答\n图像\n图片\n图片 生成\n媒体\n实现\n对话\n工具\n应用\n开关\n截图\n操作\n普通聊天\n模型设置\n测试\n生成\n视频\n编程\n编辑\n聊天\n设置\n请求\n调试\n转录\n运行\n通用\n配置\n音频\n背景\n壁纸\n背景颜色\n恢复背景\n撤销背景\n重置背景",
        },
      },
    },
    backupApp: {
      request: {
        base: "app\napp backup\napp configuration\napp_backup\napps\napps backup app\napps saved\nback\nbackup\nbackup app\nbackup user\nbackup_app\ncloud\ncloud app\ncloud apps\nconfig\nconfiguration\neliza\nexport\nexport app\nexport app config\nexport_app\nexport_app_config\nlater\nlater user\nportable\nrecreated\nsave app config\nsave_app_config\nsaved\nsettings backup app\nsnapshot\nuser\nuser eliza\nuser wants\nwants",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion aplicacion\napp\nconfiguracion\nconfiguracion aplicacion\nherramienta\nmodelo\npreferencias\nsolicitud\nusuario",
          ko: "구성\n도구\n모델 설정\n사용자\n설정\n설정 앱\n앱\n앱 앱\n요청\n작업\n토글\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes aplicativo\nferramenta\nmodelo\npreferencias\nsolicitacao\nusuario",
          tl: "aksyon\napp\napp app\nconfiguration\ngumagamit\nkahilingan\nkasangkapan\nmodel settings\npreferences\nsettings\nsettings app\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt ứng dụng\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nnguoi dung\nngười dùng\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n工具\n应用\n应用 应用\n开关\n操作\n模型设置\n用户\n设置\n设置 应用\n请求\n配置",
        },
      },
    },
    bindOauthCredential: {
      request: {
        base: "been\nbind\nbind oauth\nbind oauth credential\nbind_oauth_credential\ncallback\nconfirm oauth bind\nconfirm_oauth_bind\nconnector\nconnector identity\nfinalize oauth bind\nfinalize_oauth_bind\nidentity\nintent\nintent connector\noauth\noauth intent\nprovider\nvalidated",
        locales: {
          es: "accion\nautorizacion\nconector\nherramienta\noauth\nsolicitud",
          ko: "oauth\n도구\n요청\n인증\n작업\n커넥터",
          pt: "acao\nautorizacao\nconector\nferramenta\noauth\nsolicitacao",
          tl: "aksyon\nconnector\nkahilingan\nkasangkapan\noauth",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nket noi\nkết nối\noauth\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN": "oauth\n工具\n授权\n操作\n请求\n连接器",
        },
      },
    },
    bookInfluencer: {
      request: {
        base: "apps book influencer\nask\nask only\nbook\nbook hire\nbook influencer\nbook_influencer\nbooking\ncloud\nconfirm\nconfirmation\nconfirmation user\nconfirms\ncredits\neliza\nescrowed\nexplicit\nfinance book influencer\nfirst\nfirst ask\nfunded\nfunds\nhire\nhire influencer\nhire_influencer\ninfluencer\nintent\nmoney\noffer\nonly\npay\npay influencer\npay_influencer\npromote\npromote with influencer\npromote_with_influencer\nsettings book influencer\nsponsor\nsponsor influencer\nsponsor pay\nsponsor_influencer\nstep\nuser\nuser wants\nwants",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion reservar\napp\nconfiguracion\nconfiguracion reservar\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\npagar\nportafolio\npreferencias\npreguntar\nreservar\nsaldo\nsolicitud\nusuario",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n설정\n설정 예약\n앱\n앱 예약\n예약\n요청\n작업\n잔액\n지불\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo reservar\napp\nconfiguracao\nconfiguracoes\nconfiguracoes reservar\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\npagar\nperguntar\nportfolio\npreferencias\nreservar\nsaldo\nsolicitacao\nusuario",
          tl: "account\naksyon\napp\napp mag-book\nbalance\nconfiguration\nfinance\ngumagamit\ninvoice\nireserba\nkahilingan\nkasangkapan\nmag-book\nmagbayad\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings mag-book\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt đặt\ncấu hình\ncong cu\ncông cụ\ndat\nđặt\nhanh dong\nhành động\nhoi\nhỏi\nnguoi dung\nngười dùng\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntra tien\ntrả tiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng đặt\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 预订\n开关\n投资组合\n操作\n支付\n模型设置\n用户\n设置\n设置 预订\n询问\n请求\n财务\n账户\n配置\n钱\n预订",
        },
      },
    },
    browser: {
      request: {
        base: "action\nagent\nagent autofill\nauthorized\nauthorized settings\nautofill\nautofill browser login\nautofill login\nautomation browser\navailable\nback\nbridge\nbridge settings\nbrowse site\nbrowser\nbrowser action\nbrowser autofill login\nbrowser bridge\nbrowser browser\nbrowser page\nbrowser session\nchrome\nchromium\nclick\nclick type\ncompanion\ncomputeruse\nconfigured\ncontrol\ncontrol browser\ncontrol browser session\ncontrol open\ncredential\ncredential workspace\ndefault\ndesktop\ndomain\ndriven\nelectrobun\nembedded\nextension\nfalls\nfill browser credentials\ngated\njsdom\nlocal\nlog into site\nlogin\nlogin domain\nlogins\nlogins bridge\nmanage browser\nmanage eliza browser workspace\nmanage lifeops browser\nmode\nnavigate\nnavigate click\nnavigate site\nopen\nopen navigate\nopen site\npage\npage control\npicks\npluggable\nplugin\npuppeteer\nreal\nregistered\nsafari\nscreenshot\nscreenshot state\nsecrets browser\nservice\nsettings\nsettings status\nsettings vault\nsign in to site\nsingle\nstate\nstatus manage\nsubaction\ntarget\ntargets\ntype\ntype screenshot\nuse browser\nuser\nuses\nvault\nvault logins\nview\nweb\nweb browser\nwhat\nworkspace authorized",
        locales: {
          es: "abrir\nabrir pagina\nabrir url\naccion\nadministrar\nagente\naplicacion\napp\nautomatizacion\nautomatizacion navegador\nbuscar web\ncaptura de pantalla\nclave api\nclic\nconfiguracion\ncontraseña\ncontrolar\ncontrolar abrir\ncontrolar navegador\ncredencial\ncron\ndisparador\nescritorio\nespacio de trabajo\nflujo de trabajo\ngestionar\ngestionar navegador\ngestionar navegador espacio de trabajo\nhacer clic\ninformacion actual\niniciar sesion\ninternet\nlimpiar\nmonitor\nnavegador\nnavegador abrir\nnavegador accion\nnavegador iniciar sesion\nnavegador navegador\nnavegador pagina\npagina\npagina controlar\nsecreto\nsecretos\nsitio web\ntoken\nultimo\nweb",
          ko: "api 키\nurl 열기\n관리\n관리 브라우저\n관리 브라우저 작업공간\n데스크톱\n도구\n로그인\n모니터\n브라우저\n브라우저 로그인\n브라우저 브라우저\n브라우저 열기\n브라우저 작업\n브라우저 페이지\n비밀\n비밀번호\n상태\n설정\n스크린샷\n시크릿\n앱\n에이전트\n열기\n요청\n워크플로\n웹\n웹 검색\n웹사이트 입력\n인터넷\n자격 증명\n자동화\n자동화 브라우저\n작업\n작업공간\n제어\n제어 브라우저\n제어 열기\n지우기\n최신\n최신 정보\n크론\n클릭\n토큰\n트리거\n페이지\n페이지 열기\n페이지 제어",
          pt: "abrir\nabrir pagina\nabrir url\nacao\nagente\naplicativo\napp\narea de trabalho\nautomacao\nautomacao navegador\nbuscar na web\ncaptura de tela\nchave api\nclicar\nconfiguracoes\ncontrolar\ncontrolar abrir\ncontrolar navegador\ncredencial\ncron\nentrar\nespaco de trabalho\nfluxo de trabalho\ngatilho\ngerenciar\ngerenciar navegador\ngerenciar navegador workspace\ninformacao atual\ninternet\nlimpar\nlogin\nmonitor\nnavegador\nnavegador abrir\nnavegador acao\nnavegador entrar\nnavegador navegador\nnavegador pagina\npagina\npagina controlar\nsegredo\nsegredos\nsenha\nsite\nstatus\ntoken\nweb\nworkspace",
          tl: "agent\naksyon\napi key\napp\nautomation\nautomation browser\nbrowser\nbrowser aksyon\nbrowser browser\nbrowser buksan\nbrowser mag-login\nbrowser pahina\nbuksan\nbuksan ang pahina\nclick\ncredential\ncron\ndesktop\ninternet\nkahilingan\nkasalukuyang impormasyon\nkasangkapan\nkontrol\nkontrol browser\nkontrol buksan\nlinisin\nmag-login\nmonitor\nopen url\npahina\npahina kontrol\npamahalaan\npamahalaan browser\npamahalaan browser workspace\npassword\nscreenshot\nsearch web\nsecret\nsettings\nstatus\ntoken\ntrigger\nweb\nwebsite\nworkflow\nworkspace",
          vi: "anh chup man hinh\nảnh chụp màn hình\nbi mat\nbí mật\ncai dat\ncài đặt\ndang nhap\nđăng nhập\ndieu khien\nđiều khiển\nđiều khiển mở\nđiều khiển trình duyệt\nhanh dong\nhành động\nkhoa api\nkhóa api\nkhong gian lam viec\nkhông gian làm việc\nkich hoat\nmật khẩu\nmay tinh de ban\nmáy tính để bàn\nmo trang\nmở trang\nquan ly\nquản lý\nquản lý trình duyệt\nquản lý trình duyệt không gian làm việc\nquy trinh\nquy trình\ntac tu\ntác tử\nthong tin hien tai\nthông tin hiện tại\ntìm web\ntrang điều khiển\ntrạng thái\ntrinh duyet\ntrình duyệt\ntrình duyệt đăng nhập\ntrình duyệt hành động\ntrình duyệt trang\ntrình duyệt trình duyệt\ntu dong hoa\ntự động hóa\ntự động hóa trình duyệt\nung dung\nứng dụng",
          "zh-CN":
            "API 密钥\n互联网\n代理\n令牌\n最新信息\n凭据\n定时\n密码\n密钥\n工作区\n工作流\n工具\n应用\n截图\n打开\n打开网址\n打开页面\n控制\n控制 打开\n控制 浏览器\n操作\n智能体\n桌面\n浏览器\n浏览器 打开\n浏览器 操作\n浏览器 浏览器\n浏览器 登录\n浏览器 页面\n清除\n点击\n状态\n登录\n监控\n秘密\n管理\n管理 浏览器\n管理 浏览器 工作区\n网站输入\n网络\n网页搜索\n自动化\n自动化 浏览器\n触发器\n设置\n请求\n页面\n页面 控制",
        },
      },
    },
    browseTaskmarketTasks: {
      request: {
        base: "automation browse taskmarket tasks\nbrowse\nbrowse open\nbrowse taskmarket tasks\nbrowse_taskmarket_tasks\ndeadline\nfind taskmarket work\nfind_taskmarket_work\nfunds\nknowledge browse taskmarket tasks\nlist taskmarket tasks\nlist_taskmarket_tasks\nmode\nopen\nopen taskmarket\nreward\nsearch taskmarket\nsearch_taskmarket\nsigning\nsigning wallet\nspending\ntaskmarket\ntaskmarket tasks\ntasks\ntasks reward\ntransactions\nwallet\nwallet transactions\nwithout",
        locales: {
          es: "abrir\naccion\nautomatizacion\nautomatizacion tarea\nbilletera\nbilletera transaccion\nbuscar\nconocimiento\nconocimiento tarea\ncron\ndisparador\nencontrar\nflujo de trabajo\nhechos guardados\nherramienta\nlistar\nlistar tarea\nmonitor\nmostrar\nnotas guardadas\nrecordar\nsolicitud\ntarea\ntransaccion\nwallet",
          ko: "거래\n검색\n도구\n모니터\n목록\n목록 작업\n열기\n요청\n워크플로\n자동화\n자동화 작업\n작업\n저장된 노트\n저장된 사실\n지갑\n지갑 거래\n지식\n지식 작업\n찾기\n크론\n트리거\n회상",
          pt: "abrir\nacao\nautomacao\nautomacao tarefa\nbuscar\ncarteira\ncarteira transacao\nconhecimento\nconhecimento tarefa\ncron\nencontrar\nfatos salvos\nferramenta\nfluxo de trabalho\ngatilho\nlembrar\nlistar\nlistar tarefa\nmonitor\nmostrar\nnotas salvas\nsolicitacao\ntarefa\ntransacao\nwallet",
          tl: "aksyon\nalalahanin\nautomation\nautomation gawain\nbuksan\ncron\ngawain\nhanapin\nilista\nilista gawain\nkaalaman\nkaalaman gawain\nkahilingan\nkasangkapan\nmaghanap\nmonitor\nsaved facts\nsaved notes\ntransaksyon\ntrigger\nwallet\nwallet transaksyon\nworkflow",
          vi: "cong cu\ncông cụ\nghi chu da luu\nghi chú đã lưu\ngiao dich\ngiao dịch\nhanh dong\nhành động\nkich hoat\nkien thuc\nkiến thức\nkiến thức nhiệm vụ\nliet ke\nliệt kê\nliệt kê nhiệm vụ\nmo\nmở\nnhiem vu\nnhiệm vụ\nnhớ lại\nquy trinh\nquy trình\ntim\ntìm\ntim kiem\ntìm kiếm\ntu dong hoa\ntự động hóa\ntự động hóa nhiệm vụ\nvi\nví\nví giao dịch\nyeu cau\nyêu cầu",
          "zh-CN":
            "交易\n任务\n列出\n列出 任务\n回忆\n定时\n工作流\n工具\n已保存事实\n已保存笔记\n打开\n搜索\n操作\n查找\n监控\n知识\n知识 任务\n自动化\n自动化 任务\n触发器\n语义搜索\n请求\n钱包\n钱包 交易",
        },
      },
    },
    buyAppDomain: {
      request: {
        base: "app\napp money\napps buy app domain\nask\nask only\nasks\nasks confirmation\nasks purchase\nattach\nbalance\nbalance first\nbuy app domain\nbuy custom domain\nbuy domain\nbuy_app_domain\nbuy_custom_domain\nbuy_domain\ncharged\ncloud\ncloud app\ncloudflare\nconfirm\nconfirmation\nconfirmation user\ncredit\ncredit balance\ndomain\neliza\nfinance buy app domain\nfirst\nfirst ask\nget a domain\nget_a_domain\nmoney\nonly\nprice\nprice asks\npurchase\npurchase domain\npurchase_domain\nquotes\nregister\nregister domain\nregister_domain\nregistrar\nsettings buy app domain\nstep\nthrough\nuser\nuser asks",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion aplicacion\napp\nconfiguracion\nconfiguracion aplicacion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nobtener\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "가져오기\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 앱\n앱\n앱 앱\n요청\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes aplicativo\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nobter\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp app\nbalance\nconfiguration\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkunin\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings app\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt ứng dụng\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nlay\nlấy\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 应用\n开关\n投资组合\n操作\n模型设置\n用户\n用户 询问\n获取\n设置\n设置 应用\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    calendar: {
      request: {
        base: "book time block\nbook_time_block\ncalendar\ncalendar action\ncalendar calendar\ncalendar create event\ncalendar feed\ncalendar next event\ncalendar read\ncalendar search events\ncalendar view\ncalendar_action\ncalendar_create_event\ncalendar_feed\ncalendar_next_event\ncalendar_read\ncalendar_search_events\ncheck calendar\ncheck schedule\ncheck_calendar\ncheck_schedule\ncontacts calendar\ncreate\ncreate calendar event\ncreate query\ncreate_calendar_event\nemail\nemail habits\nhabits\nitinerary\nlife\nlife calendar\nnext meeting\nnext_meeting\nquery\nquery travel\nrebook travel\nrebook_travel\nrecurring time block\nrecurring_time_block\nschedule event\nschedule_event\nsearch\nsearch calendar\nsearch create\nsearch_calendar\nshow calendar today\nshow_calendar_today\ntasks calendar\ntoday schedule\ntoday_schedule\ntravel\ntravel email\ntravel schedule\ntravel_schedule\nview\nview search\nweek ahead\nweek view\nweek_ahead\nweek_view\nwhats my next meeting\nwhats_my_next_meeting",
        locales: {
          es: "accion\nagendar\namigo\nbloquear\nbuscar\nbuscar calendario\nbuscar crear\ncalendario\ncalendario accion\ncalendario buscar\ncalendario calendario\ncalendario crear\ncalendario leer\ncolega\ncomprobar\nconsulta\nconsulta viaje\ncontacto\ncontacto calendario\ncontactos\ncorreo\ncrear\ncrear calendario\ncrear consulta\nemail\nfecha limite\ngente\nherramienta\nleer\npendiente\npersona\nprogramar\nrecordatorio\nrelacion\nreservar\nreservar bloquear\nrevisar\nrevisar calendario\nrevisar programar\nseguimiento\nsolicitud\ntarea\ntarea calendario\ntareas\nviaje\nviaje correo\nviaje programar",
          ko: "검색\n검색 생성\n검색 캘린더\n관계\n도구\n동료\n리마인더\n마감일\n사람\n생성\n생성 캘린더\n생성 쿼리\n여행\n여행 예약\n여행 이메일\n연락처\n연락처 캘린더\n예약\n예약 차단\n요청\n이메일\n일정\n읽기\n작업\n작업 캘린더\n질의\n차단\n친구\n캘린더\n캘린더 검색\n캘린더 생성\n캘린더 읽기\n캘린더 작업\n캘린더 캘린더\n쿼리\n쿼리 여행\n할 일\n확인\n확인 예약\n확인 캘린더\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\nagendar\namigo\nbloquear\nbuscar\nbuscar calendario\nbuscar criar\ncalendario\ncalendario acao\ncalendario buscar\ncalendario calendario\ncalendario criar\ncalendario ler\ncolega\nconsulta\nconsulta viagem\ncontato\ncontato calendario\ncontatos\ncorreio\ncriar\ncriar calendario\ncriar consulta\nemail\nferramenta\nlembrete\nler\npessoa\npessoas\nprazo\nrelacao\nreservar\nreservar bloquear\nsolicitacao\ntarefa\ntarefa calendario\ntarefas\nverificar\nverificar agendar\nverificar calendario\nviagem\nviagem agendar\nviagem email",
          tl: "aksyon\nbasahin\nbiyahe\nbiyahe email\nbiyahe i-schedule\ncontact\ncontact kalendaryo\ncontacts\ndeadline\nemail\nfollow up\ngawain\ngawain kalendaryo\ngumawa\ngumawa kalendaryo\ngumawa query\ni-block\ni-schedule\nireserba\nkahilingan\nkaibigan\nkalendaryo\nkalendaryo aksyon\nkalendaryo basahin\nkalendaryo gumawa\nkalendaryo kalendaryo\nkalendaryo maghanap\nkasamahan\nkasangkapan\nkoreo\nmag-book\nmag-book i-block\nmaghanap\nmaghanap gumawa\nmaghanap kalendaryo\npaalala\nquery\nquery biyahe\nrelasyon\nsuriin\nsuriin i-schedule\nsuriin kalendaryo\ntao\ntask\ntodo",
          vi: "cong cu\ncông cụ\nđặt chặn\ndu lich\ndu lịch\ndu lịch email\ndu lịch lên lịch\nhanh dong\nhành động\nkiem tra\nkiểm tra\nkiểm tra lên lịch\nkiểm tra lịch\nlen lich\nlên lịch\nlich\nlịch\nlịch đọc\nlịch hành động\nlịch lịch\nlịch tạo\nlịch tìm kiếm\nlien he\nliên hệ\nliên hệ lịch\nnguoi\nngười\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnhiệm vụ lịch\nquan he\nquan hệ\ntac vu\ntác vụ\ntạo lịch\ntạo truy vấn\ntim kiem\ntìm kiếm\ntìm kiếm lịch\ntìm kiếm tạo\ntruy van\ntruy vấn\ntruy vấn du lịch\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "人物\n任务\n任务 日历\n关系\n创建\n创建 日历\n创建 查询\n同事\n安排\n工具\n待办\n截止日期\n提醒\n搜索\n搜索 创建\n搜索 日历\n操作\n旅行\n旅行 安排\n旅行 邮件\n日历\n日历 创建\n日历 搜索\n日历 操作\n日历 日历\n日历 读取\n朋友\n查询\n查询 旅行\n检查\n检查 安排\n检查 日历\n联系人\n联系人 日历\n请求\n读取\n跟进\n邮件\n阻止\n预订\n预订 阻止",
        },
      },
    },
    channelTopicsSearch: {
      request: {
        base: "channel\nchannel topics search\nchannel_topics_search\nmatching\nmatching rooms\nranked\nrecent\nrelevance\nreturns\nrooms\nrooms ranked\nrooms returns\nsearch\nsearch recent\ntopics\ntopics rooms",
        locales: {
          es: "accion\nbuscar\nchat\nherramienta\nsala\nsolicitud",
          ko: "검색\n도구\n방\n요청\n작업\n채팅방",
          pt: "acao\nbuscar\nchat\nferramenta\nsala\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan\nkuwarto\nmaghanap\nroom",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nphong\nphòng\ntim kiem\ntìm kiếm\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n房间\n搜索\n操作\n聊天室\n请求",
        },
      },
    },
    character: {
      request: {
        base: "actions\nactions modify\nadmin character\nagent\nagent character\nagent internal character\nagent replace\nagent_internal character\ncharacter\ncharacter actions\ncharacter modify\ncharacter persistence\ndriven\nflush\nflush memory\nformat\nidentity\nmedia character\nmemory\nmemory runtime\nmodify\nmodify character\nmodify_character\nname\npersist\npersist character\npersist update\npersist_character\npersistence\npersonality\nprompt\nrename\nrename agent\nrename_agent\nreplace\nresponse\nruntime\nruntime character\nservice\nservice update\nset agent name\nset identity\nset system prompt\nset_agent_name\nset_identity\nset_system_prompt\nsettings character\nstyle\nsystem\ntone\ntopics\nupdate\nupdate agent\nupdate agent name\nupdate identity\nupdate owner name\nupdate system prompt\nupdate_agent_name\nupdate_identity\nupdate_owner_name\nupdate_system_prompt\nvoice",
        locales: {
          es: "accion\nactivar\nactualizar\nactualizar agente\nadministrador\nadministrador personaje\nagente\nagente personaje\najustes\naudio\ncaptura\nconfiguracion\nconfiguracion personaje\ndueño\nestado interno\ngestion interna\nherramienta\nimagen\ninterno del agente\nmemoria\nmodelo\nmultimedia\nmultimedia personaje\npermisos\npersonaje\npersonaje accion\npolitica\npreferencias\nroles\nsolicitud\ntranscripcion\nvideo",
          ko: "관리자\n관리자 캐릭터\n구성\n권한\n기억\n내부 상태\n도구\n모델 설정\n미디어\n미디어 캐릭터\n비디오\n설정\n설정 캐릭터\n소유자\n스크린샷\n업데이트\n업데이트 에이전트\n에이전트\n에이전트 내부\n에이전트 캐릭터\n역할\n오디오\n요청\n이미지\n자체 관리\n작업\n전사\n정책\n캐릭터\n캐릭터 작업\n토글\n환경설정",
          pt: "acao\nadministrador\nadministrador personagem\nagente\nagente personagem\nalternar\natualizar\natualizar agente\naudio\ncaptura\nconfiguracao\nconfiguracoes\nconfiguracoes personagem\ndono\nestado interno\nferramenta\nfuncoes\ngestao interna\nimagem\ninterno do agente\nmemoria\nmidia\nmidia personagem\nmodelo\npermissoes\npersonagem\npersonagem acao\npolitica\npreferencias\nsolicitacao\ntranscricao\nvideo",
          tl: "admin\nadmin karakter\nagent\nagent karakter\naksyon\nalaala\naudio\nconfiguration\ni-update\ni-update agent\ninternal ng agent\ninternal state\nkahilingan\nkarakter\nkarakter aksyon\nkasangkapan\nlarawan\nmay ari\nmedia\nmedia karakter\nmemory\nmodel settings\npahintulot\npatakaran\npreferences\nrole\nsariling pamamahala\nscreenshot\nsettings\nsettings karakter\ntoggle\ntranscript\nvideo",
          vi: "âm thanh\ncai dat\ncài đặt\ncài đặt nhân vật\ncap nhat\ncập nhật\ncập nhật tác tử\ncấu hình\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nđa phương tiện nhân vật\nhanh dong\nhành động\nhinh anh\nhình ảnh\nky uc\nký ức\nnhan vat\nnhân vật\nnhân vật hành động\nnoi bo tac tu\nnội bộ tác tử\nquan tri\nquản trị\nquản trị nhân vật\nquyen\nquyền\ntac tu\ntác tử\ntác tử nhân vật\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn\nvideo\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 角色\n代理内部\n偏好\n内部状态\n图片\n媒体\n媒体 角色\n工具\n开关\n截图\n所有者\n操作\n智能体\n更新\n更新 代理\n权限\n模型设置\n视频\n策略\n管理员\n管理员 角色\n自我管理\n角色\n角色 操作\n记忆\n设置\n设置 角色\n请求\n转录\n配置\n音频",
        },
      },
    },
    checkAppDomain: {
      request: {
        base: "apps check app domain\nasks\nasks domain\navailability\navailability yearly\navailable\ncharges\ncheck\ncheck app domain\ncheck domain\ncheck whether\ncheck_app_domain\ncheck_domain\ncosts\ndomain\ndomain availability\ndomain available\ndomain price\ndomain_available\ndomain_price\nfinance check app domain\nfree\nis domain available\nis_domain_available\nmuch\nnever\nonly\nprice\nprice read\npurchase\nread\nread only\nregister\nregisters\nregisters user\nrenewal\nrenewal read\nsearch domain\nsearch_domain\nsettings check app domain\ntaken\nuser\nuser asks\nwhat\nwhether\nyear\nyearly",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion revisar aplicacion\napp\nbuscar\ncomprobar\nconfiguracion\nconfiguracion revisar aplicacion\ncuenta\ndinero\ndisponibilidad\nfactura\nfinanzas\nherramienta\nleer\nmodelo\nportafolio\npreferencias\npreguntar\nrevisar\nrevisar aplicacion\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "가능 시간\n검색\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 확인 앱\n앱\n앱 확인 앱\n요청\n읽기\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n확인\n확인 앱\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo verificar aplicativo\napp\nbuscar\nconfiguracao\nconfiguracoes\nconfiguracoes verificar aplicativo\nconta\ndinheiro\ndisponibilidade\nfatura\nferramenta\nfinancas\nler\nmodelo\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar\nverificar\nverificar aplicativo",
          tl: "account\naksyon\napp\napp suriin app\navailability\nbalance\nbasahin\nconfiguration\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nmaghanap\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings suriin app\nsuriin\nsuriin app\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt kiểm tra ứng dụng\ncấu hình\ncong cu\ncông cụ\ndoc\nđọc\nhanh dong\nhành động\nhoi\nhỏi\nkiem tra\nkiểm tra\nkiểm tra ứng dụng\nlich ranh\nlịch rảnh\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntim kiem\ntìm kiếm\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng kiểm tra ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n可用时间\n工具\n应用\n应用 检查 应用\n开关\n投资组合\n搜索\n操作\n检查\n检查 应用\n模型设置\n用户\n用户 询问\n设置\n设置 检查 应用\n询问\n请求\n读取\n财务\n账户\n配置\n钱",
        },
      },
    },
    clipboard: {
      request: {
        base: "action\naction read\nactions\nactions read\nautomation clipboard\nclipboard\nclipboard action\nclipboard actions\nclipboard get\nclipboard_action\ncopy\nfiles clipboard\nget\nget clipboard\nhost\nlinux\npaste\npbcopy\npbpaste\npower\nread\nread clipboard\nread write\nread_clipboard\nrequires\nscreen_time clipboard\nshell\nsystem\nuse clipboard\nuse_clipboard\nuses\nwayland\nwindows\nwrite\nwrite clipboard\nwrite host\nwrite linux\nwrite_clipboard\nxclip",
        locales: {
          es: "accion\naccion leer\narchivo\narchivos\nautomatizacion\ncarpeta\ncron\ndirectorio\ndisparador\nenfoque\nescribir\nflujo de trabajo\nherramienta\nleer\nleer archivo\nleer escribir\nlimites de apps\nmonitor\nobtener\npantalla\nsolicitud\ntiempo de pantalla\nuso del dispositivo",
          ko: "가져오기\n기기 사용\n도구\n디렉터리\n모니터\n사용 보고서\n스크린 타임\n쓰기\n앱 제한\n요청\n워크플로\n읽기\n읽기 쓰기\n자동화\n작업\n작업 읽기\n집중\n크론\n트리거\n파일\n파일 쓰기\n파일 읽기\n폴더\n화면",
          pt: "acao\nacao ler\narquivo\narquivos\nautomacao\ncron\ndiretorio\nescrever\nferramenta\nfluxo de trabalho\nfoco\ngatilho\nler\nler arquivo\nler escrever\nlimites de app\nmonitor\nobter\npasta\nsolicitacao\ntela\ntempo de tela\nuso do dispositivo",
          tl: "aksyon\naksyon basahin\napp limits\nautomation\nbasahin\nbasahin file\nbasahin isulat\ncron\ndirectory\nfile\nfiles\nfocus\nfolder\ngamit ng device\nisulat\nkahilingan\nkasangkapan\nkunin\nmonitor\nscreen\nscreen time\ntrigger\nworkflow",
          vi: "cong cu\ncông cụ\ndoc\nđọc\ndoc tep\nđọc tệp\nđọc viết\ngiới hạn ứng dụng\nhanh dong\nhành động\nhành động đọc\nkich hoat\nlay\nlấy\nman hinh\nmàn hình\nquy trinh\nquy trình\ntep\ntệp\nthoi gian man hinh\nthời gian màn hình\nthu muc\nthư mục\ntu dong hoa\ntự động hóa\nviet\nviết\nyeu cau\nyêu cầu",
          "zh-CN":
            "专注\n使用报告\n写入\n写文件\n定时\n屏幕\n屏幕时间\n工作流\n工具\n应用限制\n操作\n操作 读取\n文件\n文件夹\n监控\n目录\n自动化\n获取\n触发器\n设备使用\n请求\n读取\n读取 写入\n读取文件",
        },
      },
    },
    cloudAccountStatus: {
      request: {
        base: "account\naccount credit\naccount status\nasks\nasks their\nbalance\nbalance account\nbalance balance\nbalance warning\ncheck\ncheck cloud credits\ncheck eliza\ncheck user\ncheck_cloud_credits\ncloud\ncloud account\ncloud account status\ncloud balance\ncloud cloud account status\ncloud credits\ncloud_account_status\ncloud_balance\ncloud_credits\ncredit\ncredit balance\ncredits\ncredits balance\neliza\nfinance cloud account status\nlink\nlink user\nsettings cloud account status\nstatus\ntheir\nuser\nuser asks\nuser eliza\nwarning",
        locales: {
          es: "accion\nactivar\najustes\ncomprobar\nconfiguracion\nconfiguracion cuenta estado\ncuenta\ncuenta estado\ndinero\nestado\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\npreguntar\nrevisar\nrevisar usuario\nsaldo\nsaldo cuenta\nsaldo saldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n계정 상태\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n상태\n설정\n설정 계정 상태\n요청\n작업\n잔액\n잔액 계정\n잔액 잔액\n질문\n청구서\n토글\n포트폴리오\n확인\n확인 사용자\n환경설정",
          pt: "acao\nalternar\nconfiguracao\nconfiguracoes\nconfiguracoes conta status\nconta\nconta status\ndinheiro\nestado\nfatura\nferramenta\nfinancas\nmodelo\nperguntar\nportfolio\npreferencias\nsaldo\nsaldo conta\nsaldo saldo\nsolicitacao\nstatus\nusuario\nusuario perguntar\nverificar\nverificar usuario",
          tl: "account\naccount status\naksyon\nbalance\nbalance account\nbalance balance\nconfiguration\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkuwenta\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings account status\nstatus\nsuriin\nsuriin user\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt tài khoản trạng thái\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nkiem tra\nkiểm tra\nkiểm tra người dùng\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\nsố dư số dư\nsố dư tài khoản\ntai chinh\ntài chính\ntai khoan\ntài khoản\ntài khoản trạng thái\ntien\ntiền\ntrang thai\ntrạng thái\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n余额 余额\n余额 账户\n偏好\n发票\n工具\n开关\n投资组合\n操作\n检查\n检查 用户\n模型设置\n状态\n用户\n用户 询问\n设置\n设置 账户 状态\n询问\n请求\n财务\n账号\n账户\n账户 状态\n配置\n钱",
        },
      },
    },
    cloudCreateApiKey: {
      request: {
        base: "asks\nasks create\ncloud\ncloud cloud create api key\ncloud create api key\ncloud key\ncloud_create_api_key\ncopied\ncreate\ncreate api key\ncreate eliza\ncreate generate\ncreate_api_key\neliza\ngenerate\ngenerate mint\nimmediately\nkey\nkey optional\nkey plain\nkey shown\nmake api key\nmake_api_key\nmint\nmust\nname\nname user\nnew cloud api key\nnew_cloud_api_key\nonce\noptional\nplain\nplain key\nsettings cloud create api key\nshown\nuser\nuser asks",
        locales: {
          es: "accion\nactivar\najustes\napi clave\nclave\nconfiguracion\nconfiguracion crear api clave\ncrear\ncrear api clave\ncrear generar\ngenerar\nherramienta\nmodelo\npreferencias\npreguntar\npreguntar crear\nsolicitud\ntecla\nusuario\nusuario preguntar",
          ko: "api 키\n구성\n도구\n모델 설정\n사용자\n사용자 질문\n생성\n생성 api 키\n생성 생성\n설정\n설정 생성 api 키\n요청\n작업\n질문\n질문 생성\n키\n토글\n환경설정",
          pt: "acao\nalternar\napi chave\nchave\nconfiguracao\nconfiguracoes\nconfiguracoes criar api chave\ncriar\ncriar api chave\ncriar gerar\nferramenta\ngerar\nmodelo\nperguntar\nperguntar criar\npreferencias\nsolicitacao\ntecla\nusuario\nusuario perguntar",
          tl: "aksyon\napi key\nbumuo\nconfiguration\ngumagamit\ngumawa\ngumawa api key\ngumawa bumuo\nkahilingan\nkasangkapan\nkey\nmagtanong\nmagtanong gumawa\nmodel settings\npreferences\nsettings\nsettings gumawa api key\ntoggle\nuser\nuser magtanong",
          vi: "api khóa\ncai dat\ncài đặt\ncài đặt tạo api khóa\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nhỏi tạo\nkhoa\nkhóa\nnguoi dung\nngười dùng\nngười dùng hỏi\nphim\nphím\ntao\ntạo\ntạo api khóa\ntạo tạo\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "api 键\n偏好\n创建\n创建 api 键\n创建 生成\n密钥\n工具\n开关\n操作\n模型设置\n生成\n用户\n用户 询问\n设置\n设置 创建 api 键\n询问\n询问 创建\n请求\n配置\n键",
        },
      },
    },
    cloudListAgents: {
      request: {
        base: "agents\nagents running\nagents they\nagents user\nagents whether\nasks\nasks what\ncloud\ncloud agents\ncloud cloud list agents\ncloud list agents\ncloud_list_agents\neliza\nhave\nhosted\nhosted agents\nlist\nlist agents\nlist hosted agents\nlist user\nlist_hosted_agents\nmy cloud agents\nmy_cloud_agents\nname\nname status\nrunning\nsettings cloud list agents\nshow hosted agents\nshow_hosted_agents\nstatus\nstatus user\ntheir\nthey\nuser\nuser asks\nuser hosted\nwhat\nwhat agents\nwhether",
        locales: {
          es: "accion\nactivar\nagente\nagente usuario\najustes\nconfiguracion\nconfiguracion listar agente\nestado\nestado usuario\nherramienta\nlistar\nlistar agente\nlistar usuario\nmodelo\nmostrar\npreferencias\npreguntar\nsolicitud\nusuario\nusuario preguntar",
          ko: "구성\n도구\n모델 설정\n목록\n목록 사용자\n목록 에이전트\n사용자\n사용자 질문\n상태\n상태 사용자\n설정\n설정 목록 에이전트\n에이전트\n에이전트 사용자\n요청\n작업\n질문\n토글\n환경설정",
          pt: "acao\nagente\nagente usuario\nalternar\nconfiguracao\nconfiguracoes\nconfiguracoes listar agente\nestado\nferramenta\nlistar\nlistar agente\nlistar usuario\nmodelo\nmostrar\nperguntar\npreferencias\nsolicitacao\nstatus\nstatus usuario\nusuario\nusuario perguntar",
          tl: "agent\nagent user\naksyon\nconfiguration\ngumagamit\nilista\nilista agent\nilista user\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npreferences\nsettings\nsettings ilista agent\nstatus\nstatus user\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê tác tử\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nliet ke\nliệt kê\nliệt kê người dùng\nliệt kê tác tử\nnguoi dung\nngười dùng\nngười dùng hỏi\ntac tu\ntác tử\ntác tử người dùng\ntrang thai\ntrạng thái\ntrạng thái người dùng\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 用户\n偏好\n列出\n列出 代理\n列出 用户\n工具\n开关\n操作\n智能体\n模型设置\n状态\n状态 用户\n用户\n用户 询问\n设置\n设置 列出 代理\n询问\n请求\n配置",
        },
      },
    },
    computerUse: {
      request: {
        base: "acting\naction\nactions\nadmin computer use\napp\nautomation computer use\navailable\nbefore\nbrowser\nbrowser computer use\ncanonical\ncapture screen\nclick\nclick double\nclick modified\nclick screen\nclick with modifiers\nclick_screen\nclick_with_modifiers\ncombo\ncomputer\ncomputer action\ncomputer use\ncomputer_action\ncomputer_use\ncontrol\ncontrol computer\ncontrol screenshot\ncontrol_computer\ncross\ndesktop\ndesktop action\ndesktop control\ndesktop_action\ndetect\ndirect\ndouble\ndrag\neach\nelements\nfile\nfiles computer use\nfinder\nguidance\nincludes\ninteraction\nkey\nkey combo\nkey key\nkey_combo\nlife\nlinux\nmachine\nmodified\nmodified click\nmodifiers\nmouse click\nmouse_click\nmove\nmove mouse\nmove_mouse\nnative\noperation\nowner\nplatform\nplatform desktop\nplugin\npress key\npress_key\npurpose\nreal\nrequired\nresult\nright\nscreen time computer use\nscreen_time computer use\nscreenshot\nscreenshot click\nscroll\nscroll screen\nscroll_screen\nsee screen\nstandard\ntake\ntake screenshot\nterminal\nterminal computer use\ntype\ntype key\ntype text\ntype_text\nuse computer\nuse_computer\nwindows\nworkflows\nwrapper",
        locales: {
          es: "abrir pagina\naccion\nadministrador\nadministrador computadora\narchivo\narchivo computadora\narchivos\nautomatizacion\nautomatizacion computadora\nbash\ncaptura de pantalla\ncaptura de pantalla clic\ncapturar pantalla\ncarpeta\nclave clave\nclic pantalla\ncomputadora\ncomputadora accion\ncontrolar\ncontrolar captura de pantalla\ncontrolar computadora\ncron\ndirectorio\ndisparador\ndueño\nenfoque\nescritorio\nescritorio accion\nescritorio captura de pantalla\nescritorio controlar\nflujo de trabajo\nhacer clic\nleer archivo\nlimites de apps\nlinea de comandos\nmonitor\nnavegador\nnavegador computadora\nordenador\npermisos\npolitica\nproceso\nroles\nshell\nsitio web\nterminal\ntiempo de pantalla\nuso del dispositivo",
          ko: "관리자\n관리자 컴퓨터\n권한\n기기 사용\n데스크톱\n데스크톱 스크린샷\n데스크톱 작업\n데스크톱 제어\n디렉터리\n명령줄\n모니터\n배시\n브라우저\n브라우저 컴퓨터\n사용 보고서\n셸\n소유자\n스크린 타임\n스크린샷 클릭\n앱 제한\n역할\n워크플로\n웹사이트 입력\n자동화\n자동화 컴퓨터\n작업\n정책\n제어\n제어 스크린샷\n제어 컴퓨터\n집중\n캡처 화면\n컴퓨터\n컴퓨터 작업\n크론\n클릭\n클릭 화면\n키 키\n터미널\n트리거\n파일\n파일 쓰기\n파일 읽기\n파일 컴퓨터\n페이지 열기\n폴더\n프로세스\n화면",
          pt: "abrir pagina\nacao\nadministrador\nadministrador computador\narea de trabalho\narea de trabalho acao\narea de trabalho captura de tela\narea de trabalho controlar\narquivo\narquivo computador\narquivos\nautomacao\nautomacao computador\nbash\ncaptura de tela\ncaptura de tela clicar\ncapturar tela\nchave chave\nclicar\nclicar tela\ncomputador\ncomputador acao\ncontrolar\ncontrolar captura de tela\ncontrolar computador\ncron\ndiretorio\ndono\nfluxo de trabalho\nfoco\nfuncoes\ngatilho\nler arquivo\nlimites de app\nlinha de comando\nmonitor\nnavegador\nnavegador computador\npasta\npermissoes\npolitica\nprocesso\nshell\nsite\ntela\ntempo de tela\nterminal\nuso do dispositivo",
          tl: "admin\nadmin computer\naksyon\napp limits\nautomation\nautomation computer\nbasahin file\nbash\nbrowser\nbrowser computer\nbuksan ang pahina\nclick\nclick screen\ncommand line\ncomputer\ncomputer aksyon\ncron\ndesktop\ndesktop aksyon\ndesktop kontrol\ndesktop screenshot\ndirectory\nfile\nfile computer\nfiles\nfocus\nfolder\ngamit ng device\nkey\nkey key\nkontrol\nkontrol computer\nkontrol screenshot\nkuha screen\nmay ari\nmonitor\npahintulot\npatakaran\nprocess\nrole\nscreen\nscreen time\nscreenshot click\nshell\nterminal\ntrigger\nwebsite\nworkflow",
          vi: "anh chup man hinh\nảnh chụp màn hình\nchu so huu\nchủ sở hữu\nchụp màn hình\ndieu khien\nđiều khiển\nđiều khiển ảnh chụp màn hình\nđiều khiển máy tính\ndoc tep\nđọc tệp\ndong lenh\ndòng lệnh\ngiới hạn ứng dụng\nhanh dong\nhành động\nkich hoat\nman hinh\nmàn hình\nmay tinh\nmáy tính\nmay tinh de ban\nmáy tính để bàn\nmáy tính để bàn điều khiển\nmáy tính để bàn hành động\nmáy tính hành động\nmo trang\nmở trang\nnhấp màn hình\nquan tri\nquản trị\nquản trị máy tính\nquy trinh\nquy trình\ntệp máy tính\nthoi gian man hinh\nthời gian màn hình\nthu muc\nthư mục\ntiến trình\ntrinh duyet\ntrình duyệt\ntrình duyệt máy tính\ntu dong hoa\ntự động hóa\ntự động hóa máy tính\nung dung\nứng dụng",
          "zh-CN":
            "Bash\n专注\n使用报告\n写文件\n命令行\n定时\n屏幕\n屏幕时间\n工作流\n应用限制\n截图 点击\n所有者\n打开页面\n捕获 屏幕\n控制\n控制 截图\n控制 电脑\n操作\n文件\n文件 电脑\n文件夹\n权限\n标准输出\n桌面\n桌面 截图\n桌面 控制\n桌面 操作\n浏览器\n浏览器 电脑\n点击\n点击 屏幕\n电脑\n电脑 操作\n监控\n目录\n策略\n管理员\n管理员 电脑\n终端\n网站输入\n自动化\n自动化 电脑\n角色\n触发器\n设备使用\n读取文件\n进程\n键 键",
        },
      },
    },
    computerUseAgent: {
      request: {
        base: "actor\nadmin computer use agent\nagent\nagent autonomous\nautomate screen\nautomate_screen\nautomation computer use agent\nautonomous\nautonomous desktop\nbrain\nbuilder\ncascade\ncascade click\nchat\nclick\nclick pass\ncomputer\ncomputer agent\ncomputer named\ncomputer use agent\ncomputer_use_agent\ncoords\ndesktop\ndesktop loop\ndone\ngoal\ngoal steps\ngoal until\nlevel\nloop\nloop goal\nmonitor\nmulti\nnamed\noriginating\npass\npass goal\nprefer\nprefer computer\nprogress\nrun computer agent\nrun_computer_agent\nscene\nscreen\nscreen agent\nscreen_agent\nsend\nsingle\nstep\nsteps\nsteps computer\nsteps stream\nstream\nstream progress\ntasks\ntrue\nuntil\nupdates\nuses",
        locales: {
          es: "accion\nactualizar\nadministrador\nadministrador computadora agente\nagente\nautomatizacion\nautomatizacion computadora agente\nchat\nclic\ncomputadora\ncomputadora agente\nconversacion\ncron\ndisparador\ndueño\nejecutar\nejecutar computadora agente\nenviar\nescritorio\nflujo de trabajo\nhacer clic\nherramienta\nmeta\nmonitor\nobjetivo\nordenador\npantalla\npantalla agente\npermisos\npolitica\nroles\nsolicitud\nstream\ntarea\ntransmitir",
          ko: "관리자\n관리자 컴퓨터 에이전트\n권한\n대화\n데스크톱\n도구\n모니터\n목표\n방송\n보내기\n소유자\n스트림\n실행\n실행 컴퓨터 에이전트\n업데이트\n에이전트\n역할\n요청\n워크플로\n자동화\n자동화 컴퓨터 에이전트\n작업\n정책\n채팅\n컴퓨터\n컴퓨터 에이전트\n크론\n클릭\n트리거\n화면\n화면 에이전트",
          pt: "acao\nadministrador\nadministrador computador agente\nagente\narea de trabalho\natualizar\nautomacao\nautomacao computador agente\nchat\nclicar\ncomputador\ncomputador agente\nconversa\ncron\ndono\nenviar\nexecutar\nexecutar computador agente\nferramenta\nfluxo de trabalho\nfuncoes\ngatilho\nmeta\nmonitor\nobjetivo\npermissoes\npolitica\nsolicitacao\nstream\ntarefa\ntela\ntela agente\ntransmitir",
          tl: "admin\nadmin computer agent\nagent\naksyon\nautomation\nautomation computer agent\nchat\nclick\ncomputer\ncomputer agent\ncron\ndesktop\ngawain\ni-update\nipadala\nkahilingan\nkasangkapan\nlayunin\nmay ari\nmonitor\npahintulot\npatakaran\npatakbuhin\npatakbuhin computer agent\nrole\nscreen\nscreen agent\nstream\ntrigger\nusap\nworkflow",
          vi: "cap nhat\ncập nhật\nchay\nchạy\nchạy máy tính tác tử\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ngui\ngửi\nhanh dong\nhành động\nkich hoat\nman hinh\nmàn hình\nmàn hình tác tử\nmay tinh\nmáy tính\nmay tinh de ban\nmáy tính để bàn\nmáy tính tác tử\nmuc tieu\nmục tiêu\nnhap\nnhấp\nnhiem vu\nnhiệm vụ\nphat truc tiep\nphát trực tiếp\nquan tri\nquản trị\nquản trị máy tính tác tử\nquy trinh\nquy trình\nquyen\nquyền\ntac tu\ntác tử\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntự động hóa máy tính tác tử\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n任务\n发送\n定时\n屏幕\n屏幕 代理\n工作流\n工具\n所有者\n操作\n智能体\n更新\n权限\n桌面\n点击\n电脑\n电脑 代理\n监控\n目标\n直播\n策略\n管理员\n管理员 电脑 代理\n聊天\n自动化\n自动化 电脑 代理\n角色\n触发器\n请求\n运行\n运行 电脑 代理",
        },
      },
    },
    createAdSlot: {
      request: {
        base: "add ad slot\nadd_ad_slot\napp\napp earn\napp sell\napps\napps create ad slot\napps earn\ncloud\ncloud apps\ncreate\ncreate ad placement\ncreate ad slot\ncreate slot\ncreate_ad_placement\ncreate_ad_slot\nearn\neliza\nfinance create ad slot\nmonetize\nmonetize app\nmonetize with ads\nmonetize_with_ads\nsell\nsell ad space\nsell_ad_space\nserving\nserving user\nsettings create ad slot\nslot\nslot app\nslot user\nspace\nuser\nuser eliza\nuser wants\nwants",
        locales: {
          es: "accion\nactivar\nagregar\najustes\nanadir\naplicacion\naplicacion crear\napp\nconfiguracion\nconfiguracion crear\ncrear\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\nsaldo\nsolicitud\nusuario",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n생성\n설정\n설정 생성\n앱\n앱 생성\n요청\n작업\n잔액\n청구서\n추가\n토글\n포트폴리오\n환경설정",
          pt: "acao\nadicionar\nalternar\naplicativo\naplicativo criar\napp\nconfiguracao\nconfiguracoes\nconfiguracoes criar\nconta\ncriar\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario",
          tl: "account\naksyon\napp\napp gumawa\nbalance\nconfiguration\nfinance\ngumagamit\ngumawa\nidagdag\ninvoice\nkahilingan\nkasangkapan\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings gumawa\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt tạo\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nnguoi dung\nngười dùng\nso du\nsố dư\ntai chinh\ntài chính\ntao\ntạo\nthem\nthêm\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng tạo\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n创建\n发票\n工具\n应用\n应用 创建\n开关\n投资组合\n操作\n模型设置\n添加\n用户\n设置\n设置 创建\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    createApp: {
      request: {
        base: "app\napp user\napps create app\nasks\nasks build\nbuild\nbuild app\nbuild_app\ncloud\ncloud app\ncreate\ncreate app\ncreate cloud app\ncreate eliza\ncreate start\ncreate_app\ncreate_cloud_app\ndescription\neliza\nfinance create app\nintent\nintent user\nmake\nmake app\nmake create\nmake_app\nmonetization\nname\nnew app\nnew_app\noptional\nsettings create app\nstart\nstart app\nuser\nuser asks\nuser intent\nuser name",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion crear aplicacion\naplicacion usuario\napp\nconfiguracion\nconfiguracion crear aplicacion\ncrear\ncrear aplicacion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n생성\n생성 앱\n설정\n설정 생성 앱\n앱\n앱 사용자\n앱 생성 앱\n요청\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo criar aplicativo\naplicativo usuario\napp\nconfiguracao\nconfiguracoes\nconfiguracoes criar aplicativo\nconta\ncriar\ncriar aplicativo\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp gumawa app\napp user\nbalance\nconfiguration\nfinance\ngumagamit\ngumawa\ngumawa app\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings gumawa app\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt tạo ứng dụng\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntao\ntạo\ntạo ứng dụng\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng người dùng\nứng dụng tạo ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n创建\n创建 应用\n发票\n工具\n应用\n应用 创建 应用\n应用 用户\n开关\n投资组合\n操作\n模型设置\n用户\n用户 询问\n设置\n设置 创建 应用\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    createInfluencerProfile: {
      request: {
        base: "advertisers\nagent\nagent user\nbecome\nbecome influencer\nbecome list\nbecome_influencer\nbooked\ncloud\ncloud agent\ncreate influencer profile\ncreate_influencer_profile\nearn\nearn user\neliza\nfinance create influencer profile\ninfluencer\ninfluencer profile\nlist\nlist influencer\noffer\noffer influencer services\noffer_influencer_services\nprofile\nprofile booked\nprofile eliza\npromotion\npublish\npublish influencer\npublish influencer profile\npublish_influencer_profile\nservices\nsettings create influencer profile\nuser\nuser booked\nuser wants\nwants",
        locales: {
          es: "accion\nactivar\nagente\nagente usuario\najustes\nconfiguracion\nconfiguracion crear perfil\ncrear\ncrear perfil\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nlistar\nmodelo\nmostrar\nperfil\nportafolio\npreferencias\npublicar\npublicar perfil\nsaldo\nsolicitud\nusuario",
          ko: "게시\n게시 프로필\n계정\n구성\n금융\n도구\n돈\n모델 설정\n목록\n사용자\n생성\n생성 프로필\n설정\n설정 생성 프로필\n에이전트\n에이전트 사용자\n요청\n작업\n잔액\n청구서\n토글\n포트폴리오\n프로필\n환경설정",
          pt: "acao\nagente\nagente usuario\nalternar\nconfiguracao\nconfiguracoes\nconfiguracoes criar perfil\nconta\ncriar\ncriar perfil\ndinheiro\nfatura\nferramenta\nfinancas\nlistar\nmodelo\nmostrar\nperfil\nportfolio\npreferencias\npublicar\npublicar perfil\nsaldo\nsolicitacao\nusuario",
          tl: "account\nagent\nagent user\naksyon\nbalance\nconfiguration\nfinance\ngumagamit\ngumawa\ngumawa profile\ni-publish\ni-publish profile\nilista\ninvoice\nkahilingan\nkasangkapan\nmodel settings\npera\nportfolio\npreferences\nprofile\nsettings\nsettings gumawa profile\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt tạo hồ sơ\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nho so\nhồ sơ\nliet ke\nliệt kê\nnguoi dung\nngười dùng\nso du\nsố dư\ntac tu\ntác tử\ntác tử người dùng\ntai chinh\ntài chính\ntao\ntạo\ntạo hồ sơ\ntien\ntiền\ntuy chon\ntùy chọn\nxuat ban\nxuất bản\nxuất bản hồ sơ\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 用户\n余额\n偏好\n列出\n创建\n创建 资料\n发布\n发布 资料\n发票\n工具\n开关\n投资组合\n操作\n智能体\n模型设置\n用户\n设置\n设置 创建 资料\n请求\n财务\n账户\n资料\n配置\n钱",
        },
      },
    },
    createOauthIntent: {
      request: {
        base: "calendly\ncreate\ncreate oauth\ncreate oauth intent\ncreate_oauth_intent\ndiscord\ngithub\ngoogle\nhash\nintent\nlinear\nlinear shopify\nlinkedin\nlinkedin linear\nnew oauth intent\nnew_oauth_intent\nnotion\noauth\noauth intent\nopen oauth intent\nopen_oauth_intent\nprovider\nscopes\nshopify\nshopify calendly\nslack\nstart oauth flow\nstart_oauth_flow\nstate\nstate token\ntoken\ntoken hash",
        locales: {
          es: "abrir\nabrir oauth\naccion\nautorizacion\ncrear\ncrear oauth\nherramienta\nlinear\nlinear shopify\noauth\nshopify\nsolicitud\ntienda\ntoken",
          ko: "oauth\n도구\n리니어\n리니어 쇼피파이\n생성\n생성 oauth\n쇼피파이\n스토어\n열기\n열기 oauth\n요청\n인증\n작업\n토큰",
          pt: "abrir\nabrir oauth\nacao\nautorizacao\ncriar\ncriar oauth\nferramenta\nlinear\nlinear shopify\nloja\noauth\nshopify\nsolicitacao\ntoken",
          tl: "aksyon\nbuksan\nbuksan oauth\ngumawa\ngumawa oauth\nkahilingan\nkasangkapan\nlinear\nlinear shopify\noauth\nshopify\ntindahan\ntoken",
          vi: "cong cu\ncông cụ\ncua hang\ncửa hàng\nhanh dong\nhành động\nlinear\nlinear shopify\nmo\nmở\nmở oauth\noauth\nshopify\ntao\ntạo\ntạo oauth\ntoken\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN":
            "linear\nlinear shopify\noauth\nshopify\n代币\n令牌\n创建\n创建 oauth\n商店\n工具\n打开\n打开 oauth\n授权\n操作\n请求",
        },
      },
    },
    database: {
      request: {
        base: "admin database\nagent\nagent database\nagent internal database\nagent_internal database\nbrowse table\nbrowse_table\ndatabase\ndatabase list\ndb query\ndb tables\ndb_query\ndb_tables\ndefault\ndefault search\ndocuments database\nembedding search\nembedding_search\nexecute database query\nexecute_database_query\nget\nget table\nget table data\nget_table_data\ninspect\ninspect query\nlist\nlist database tables\nlist tables\nlist_database_tables\nlist_tables\nmemory\nmemory database\nmemory search\nonly\nquery\nquery agent\nquery read\nread\nread only\nread table\nread_table\nrun query\nrun_query\nsearch\nsearch vectors\nsearch_vectors\nselect table\nselect_table\nsemantic\nsemantic memory\nshow tables\nshow_tables\nsimilarity search\nsimilarity_search\nsql query\nsql_query\ntable\ntable query\ntables\ntables get\nvector search\nvector_search\nvectors",
        locales: {
          es: "accion\nadministrador\nadministrador base de datos\nagente\nagente base de datos\narchivo\nbase de datos\nbase de datos listar\nbuscar\nconsulta\nconsulta agente\nconsulta leer\ndocumento\ndocumento base de datos\ndocumentos\ndueño\nejecutar\nejecutar base de datos consulta\nejecutar consulta\nestado interno\ngestion interna\nguardar memoria\nguardar notas\nherramienta\ninterno del agente\nleer\nlistar\nlistar base de datos\nmemoria\nmemoria base de datos\nmemoria buscar\nmostrar\nnotas\nobtener\npermisos\npolitica\nrecordar\nrecuerdo\nroles\nsolicitud\nsql consulta",
          ko: "sql 쿼리\n가져오기\n검색\n관리자\n관리자 데이터베이스\n권한\n기억\n기억 검색\n기억 데이터베이스\n기억해\n내부 상태\n노트\n데이터베이스\n데이터베이스 목록\n도구\n목록\n목록 데이터베이스\n문서\n문서 데이터베이스\n소유자\n실행\n실행 데이터베이스 쿼리\n실행 쿼리\n에이전트\n에이전트 내부\n에이전트 데이터베이스\n역할\n요청\n읽기\n자체 관리\n작업\n장기 기억\n저장\n정책\n질의\n쿼리\n쿼리 에이전트\n쿼리 읽기\n파일 내용\n회상",
          pt: "acao\nadministrador\nadministrador banco de dados\nagente\nagente banco de dados\narquivo\nbanco de dados\nbanco de dados listar\nbuscar\nconsulta\nconsulta agente\nconsulta ler\ndocumento\ndocumento banco de dados\ndocumentos\ndono\nestado interno\nexecutar\nexecutar banco de dados consulta\nexecutar consulta\nferramenta\nfuncoes\ngestao interna\ninterno do agente\nlembrar\nler\nlistar\nlistar banco de dados\nmemoria\nmemoria banco de dados\nmemoria buscar\nmostrar\nnotas\nobter\npermissoes\npolitica\nrecordar\nsalvar memoria\nsalvar notas\nsolicitacao\nsql consulta",
          tl: "admin\nadmin database\nagent\nagent database\naksyon\nalaala\nalalahanin\nbasahin\ndatabase\ndatabase ilista\ndokumento\ndokumento database\ni-save\nilista\nilista database\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nkunin\nlong term memory\nmaghanap\nmay ari\nmemory\nmemory database\nmemory maghanap\nnilalaman ng file\nnotes\npahintulot\npatakaran\npatakbuhin\npatakbuhin database query\npatakbuhin query\nquery\nquery agent\nquery basahin\nrole\nsariling pamamahala\nsql query\ntandaan",
          vi: "chạy truy vấn\nchu so huu\nchủ sở hữu\nco so du lieu\ncơ sở dữ liệu\ncơ sở dữ liệu liệt kê\ncong cu\ncông cụ\nghi chu\nghi chú\nghi nho\nghi nhớ\nhanh dong\nhành động\nky uc\nký ức\nký ức cơ sở dữ liệu\nký ức tìm kiếm\nliet ke\nliệt kê\nliệt kê cơ sở dữ liệu\nlưu ghi chú\nnoi bo tac tu\nnội bộ tác tử\nquan tri\nquản trị\nquản trị cơ sở dữ liệu\nquyền\nsql truy vấn\ntac tu\ntác tử\ntác tử cơ sở dữ liệu\ntai lieu\ntài liệu\ntài liệu cơ sở dữ liệu\nthuc thi\nthực thi\nthực thi cơ sở dữ liệu truy vấn\ntim kiem\ntìm kiếm\ntruy van\ntruy vấn\ntruy vấn đọc\ntruy vấn tác tử\ntu quan ly\ntự quản lý\nyeu cau\nyêu cầu",
          "zh-CN":
            "sql 查询\n代理\n代理 数据库\n代理内部\n保存笔记\n内部状态\n列出\n列出 数据库\n回忆\n工具\n所有者\n执行\n执行 数据库 查询\n搜索\n操作\n数据库\n数据库 列出\n文件内容\n文档\n文档 数据库\n智能体\n权限\n查询\n查询 代理\n查询 读取\n笔记\n策略\n管理员\n管理员 数据库\n自我管理\n获取\n角色\n记住\n记忆\n记忆 搜索\n记忆 数据库\n请求\n读取\n运行\n运行 查询\n长期记忆",
        },
      },
    },
    declareSubAgentCredentialScope: {
      request: {
        base: "agent\nagent returns\nbearer\nbearer token\nbundle\nchild\ncoding\ncoding agent\ncollect\ncredential\ndeclare\ndeclare sub agent credential scope\ndeclare_sub_agent_credential_scope\ndispatched\ngrant sub agent credentials\ngrant_sub_agent_credentials\nlived\nmissing\nopen sub agent credential scope\nopen_sub_agent_credential_scope\nowner\nplus\nplus request\nprovision sub agent secrets\nprovision_sub_agent_secrets\nrequest\nrequest dispatched\nreturns\nscope\nscoped\nshort\nshot\nspawned\ntime\ntoken\ntoken plus\nvalues",
        locales: {
          es: "abrir\nabrir agente\naccion\nagente\nagente secreto\nclave secreta\nherramienta\npedir\nsecreto\nsolicitud\ntoken",
          ko: "도구\n비밀\n시크릿\n에이전트\n에이전트 비밀\n열기\n열기 에이전트\n요청\n작업\n토큰",
          pt: "abrir\nabrir agente\nacao\nagente\nagente segredo\nferramenta\npedir\nsegredo\nsolicitacao\ntoken",
          tl: "agent\nagent secret\naksyon\nbuksan\nbuksan agent\nhiling\nkahilingan\nkasangkapan\nsecret\ntoken",
          vi: "bi mat\nbí mật\ncong cu\ncông cụ\nhanh dong\nhành động\nmo\nmở\nmở tác tử\ntac tu\ntác tử\ntác tử bí mật\ntoken\nyeu cau\nyêu cầu",
          "zh-CN":
            "代币\n代理\n代理 密钥\n令牌\n密钥\n工具\n打开\n打开 代理\n操作\n智能体\n秘密\n请求",
        },
      },
    },
    deleteApp: {
      request: {
        base: "app\napp container\napp destructive\napps delete app\nask\nask only\nasks\nasks delete\ncloud\ncloud app\nconfirm\nconfirmation\nconfirms\ncontainer\ndatabase\ndatabase requires\ndelete\ndelete app\ndelete cloud\ndelete cloud app\ndelete eliza\ndelete my app\ndelete remove\ndelete_app\ndelete_cloud_app\ndelete_my_app\ndestroy\ndestroy app\ndestroy_app\ndestructive\ndown\ndown app\neliza\nexplicit\nfinance delete app\nfirst\nfirst ask\nintent\nintent user\nonly\nremove\nremove app\nremove destroy\nremove_app\nrequires\nsettings delete app\nstep\ntears\ntenant\ntenant database\nuser\nuser asks",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion eliminar aplicacion\napp\nbase de datos\nborrar\nconfiguracion\nconfiguracion eliminar aplicacion\ncuenta\ndinero\neliminar\neliminar aplicacion\neliminar eliminar\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\npreguntar\npreguntar eliminar\nquitar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n데이터베이스\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n삭제\n삭제 앱\n삭제 제거\n설정\n설정 삭제 앱\n앱\n앱 삭제 앱\n요청\n작업\n잔액\n제거\n제거 앱\n질문\n질문 삭제\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\napagar\naplicativo\naplicativo excluir aplicativo\napp\nbanco de dados\nconfiguracao\nconfiguracoes\nconfiguracoes excluir aplicativo\nconta\ndinheiro\nexcluir\nexcluir aplicativo\nexcluir remover\nfatura\nferramenta\nfinancas\nmodelo\nperguntar\nperguntar excluir\nportfolio\npreferencias\nremover\nremover aplicativo\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\nalisin\nalisin app\napp\napp burahin app\nbalance\nburahin\nburahin alisin\nburahin app\nconfiguration\ndatabase\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmagtanong burahin\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings burahin app\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt xóa ứng dụng\ncấu hình\nco so du lieu\ncơ sở dữ liệu\ncong cu\ncông cụ\ngo\ngỡ\ngỡ ứng dụng\nhanh dong\nhành động\nhoi\nhỏi\nhỏi xóa\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng xóa ứng dụng\nxoa\nxóa\nxóa gỡ\nxóa ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n删除\n删除 应用\n删除 移除\n发票\n工具\n应用\n应用 删除 应用\n开关\n投资组合\n操作\n数据库\n模型设置\n用户\n用户 询问\n移除\n移除 应用\n设置\n设置 删除 应用\n询问\n询问 删除\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    deliverOauthLink: {
      request: {
        base: "authorization\nchannel\nchosen\ndeliver\ndeliver oauth\ndeliver oauth link\ndeliver_oauth_link\ndispatch\ndispatch oauth link\ndispatch_oauth_link\nexisting\nexisting oauth\nintent\nlink\noauth\noauth intent\noauth link\nregistry\nsend oauth link\nsend_oauth_link",
        locales: {
          es: "accion\nautorizacion\nenviar\nenviar oauth\nherramienta\noauth\nsolicitud",
          ko: "oauth\n도구\n보내기\n보내기 oauth\n요청\n인증\n작업",
          pt: "acao\nautorizacao\nenviar\nenviar oauth\nferramenta\noauth\nsolicitacao",
          tl: "aksyon\nipadala\nipadala oauth\nkahilingan\nkasangkapan\noauth",
          vi: "cong cu\ncông cụ\ngui\ngửi\ngửi oauth\nhanh dong\nhành động\noauth\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN": "oauth\n发送\n发送 oauth\n工具\n授权\n操作\n请求",
        },
      },
    },
    deliverPluginConfigForm: {
      request: {
        base: "config\nconfig keys\ndeliver plugin config form\ndeliver_plugin_config_form\ndispatch\ndispatch key\ndispatches\nkey\nkey plugin\nkey sensitive\nkeys\nmints\nmissing\nplugin\nplugin missing\nrequest\nrequest missing\nrequest plugin\nrequest plugin secrets\nrequest_plugin_secrets\nrequired\nrequired key\nsend plugin config form\nsend_plugin_config_form\nsensitive\nsensitive request",
        locales: {
          es: "accion\nclave\nclave plugin\nclave secreta\ncomplemento\nenviar\nenviar plugin\nherramienta\npedir\nplugin\nsecreto\nsolicitud\nsolicitud plugin\nsolicitud plugin secreto\ntecla",
          ko: "도구\n보내기\n보내기 플러그인\n비밀\n시크릿\n요청\n요청 플러그인\n요청 플러그인 비밀\n작업\n키\n키 플러그인\n플러그인",
          pt: "acao\nchave\nchave plugin\nenviar\nenviar plugin\nferramenta\npedir\nplugin\nsegredo\nsolicitacao\nsolicitacao plugin\nsolicitacao plugin segredo\ntecla",
          tl: "aksyon\nhiling\nipadala\nipadala plugin\nkahilingan\nkahilingan plugin\nkahilingan plugin secret\nkasangkapan\nkey\nkey plugin\nplugin\nsecret",
          vi: "bi mat\nbí mật\ncong cu\ncông cụ\ngui\ngửi\ngửi plugin\nhanh dong\nhành động\nkhoa\nkhóa\nkhóa plugin\nphim\nphím\nplugin\nyeu cau\nyêu cầu\nyêu cầu plugin\nyêu cầu plugin bí mật",
          "zh-CN":
            "发送\n发送 插件\n密钥\n工具\n插件\n操作\n秘密\n请求\n请求 插件\n请求 插件 密钥\n键\n键 插件",
        },
      },
    },
    deployApp: {
      request: {
        base: "action\naction create\nalready\nanything\napp\napp action\napp confirm\napp verify\napps deploy app\nasks\nbuild\nbuild finish\nbuilding\ncannot\ncloud\ncloud app\nconfirm\ncreate\ndeploy\ndeploy app\ndeploy cloud app\ndeploy_app\ndeploy_cloud_app\neliza\nexisting\nexists\nfinance deploy app\nfinish\nfinish verifies\ngo live\ngo_live\nhost\nhosting\ninstead\nlink\nlive\nonly\nonly app\npage\npublic\nresponds\nsettings deploy app\nship\nship app\nship_app\nsite\nsomething\nsomething app\nuser\nverifies\nverify\nwaits\nwants\nweb",
        locales: {
          es: "accion\naccion crear\nactivar\najustes\naplicacion\naplicacion accion\naplicacion aplicacion\napp\nconfiguracion\nconfiguracion aplicacion\ncrear\ncuenta\ndinero\nfactura\nfinalizar\nfinanzas\nherramienta\nmodelo\npagina\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nweb",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n생성\n설정\n설정 앱\n앱\n앱 앱\n앱 작업\n완료\n요청\n웹\n작업\n작업 생성\n잔액\n질문\n청구서\n토글\n페이지\n포트폴리오\n환경설정",
          pt: "acao\nacao criar\nalternar\naplicativo\naplicativo acao\naplicativo aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes aplicativo\nconta\ncriar\ndinheiro\nfatura\nferramenta\nfinalizar\nfinancas\nmodelo\npagina\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nweb",
          tl: "account\naksyon\naksyon gumawa\napp\napp aksyon\napp app\nbalance\nconfiguration\nfinance\ngumagamit\ngumawa\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npahina\npera\nportfolio\npreferences\nsettings\nsettings app\ntapusin\ntoggle\nuser\nweb",
          vi: "cai dat\ncài đặt\ncài đặt ứng dụng\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhành động tạo\nhoi\nhỏi\nket thuc\nkết thúc\nnguoi dung\nngười dùng\nso du\nsố dư\ntai chinh\ntài chính\ntao\ntạo\ntien\ntiền\ntrang\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng hành động\nứng dụng ứng dụng\nweb\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n创建\n发票\n工具\n应用\n应用 应用\n应用 操作\n开关\n投资组合\n操作\n操作 创建\n模型设置\n用户\n结束\n网页\n设置\n设置 应用\n询问\n请求\n财务\n账户\n配置\n钱\n页面",
        },
      },
    },
    deployFrontend: {
      request: {
        base: "action\naction create\nalready\nanalytics\napp\napp action\napp static\napps deploy frontend\nasks\nbuild\nbuilding\nbuilt\ncloud\ncloud app\ncreate\ndeploy\ndeploy frontend\ndeploy site\ndeploy_frontend\ndeploy_site\ndirectory\ndirectory files\neliza\nexisting\nexists\nfiles\nfiles existing\nfrontend\nhost\nhost frontend\nhost site\nhost_frontend\nhost_site\nhosting\ninstead\nlink\nlive\nmanaged\nonly\npage\npublish\npublish existing\npublish frontend\npublish site\npublish static\npublish_frontend\npublish_site\nserved\nsettings deploy frontend\nsite\nsomething\nsomething app\nstatic\nthat\nuser\nwants\nweb\nwebsite",
        locales: {
          es: "accion\naccion crear\nactivar\najustes\naplicacion\naplicacion accion\napp\narchivo\nconfiguracion\ncrear\nherramienta\nmodelo\npagina\npreferencias\npreguntar\npublicar\nsitio web\nsolicitud\nusuario\nweb",
          ko: "게시\n구성\n도구\n모델 설정\n사용자\n생성\n설정\n앱\n앱 작업\n요청\n웹\n웹사이트\n작업\n작업 생성\n질문\n토글\n파일\n페이지\n환경설정",
          pt: "acao\nacao criar\nalternar\naplicativo\naplicativo acao\napp\narquivo\nconfiguracao\nconfiguracoes\ncriar\nferramenta\nmodelo\npagina\nperguntar\npreferencias\npublicar\nsite\nsolicitacao\nusuario\nweb",
          tl: "aksyon\naksyon gumawa\napp\napp aksyon\nconfiguration\nfile\ngumagamit\ngumawa\ni-publish\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npahina\npreferences\nsettings\ntoggle\nuser\nweb\nwebsite",
          vi: "cai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhành động tạo\nhoi\nhỏi\nnguoi dung\nngười dùng\ntao\ntạo\ntep\ntệp\ntrang\ntrang web\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng hành động\nweb\nxuat ban\nxuất bản\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n创建\n发布\n工具\n应用\n应用 操作\n开关\n操作\n操作 创建\n文件\n模型设置\n用户\n网站\n网页\n设置\n询问\n请求\n配置\n页面",
        },
      },
    },
    disableAutonomousMode: {
      request: {
        base: "admin\nadmin call\nadmin disable autonomous mode\nautonomous\nautonomy\ncall\ncall stop\ncontinuous\ndisable\ndisable autonomous\ndisable autonomous mode\ndisable autonomy\ndisable_autonomous_mode\ndisable_autonomy\nloop\nmessaging disable autonomous mode\nmode\nowner\nowner admin\nstop\nstop autonomous mode\nstop autonomy\nstop continuous\nstop_autonomous_mode\nstop_autonomy",
        locales: {
          es: "accion\nadministrador\nadministrador desactivar\nadministrador llamar\ndesactivar\ndetener\ndueño\nherramienta\nllamada\nllamar\nllamar detener\nparar\npermisos\npolitica\nroles\nsolicitud",
          ko: "관리자\n관리자 비활성화\n관리자 통화\n권한\n도구\n비활성화\n소유자\n역할\n요청\n작업\n전화\n정책\n중지\n통화\n통화 중지",
          pt: "acao\nadministrador\nadministrador desativar\nadministrador ligar\nchamada\ndesativar\ndono\nferramenta\nfuncoes\nligar\nligar parar\nparar\npermissoes\npolitica\nsolicitacao",
          tl: "admin\nadmin i-disable\nadmin tawag\naksyon\ni-disable\nitigil\nkahilingan\nkasangkapan\nmay ari\npahintulot\npatakaran\nrole\ntawag\ntawag itigil",
          vi: "chu so huu\nchủ sở hữu\ncong cu\ncông cụ\ndung\ndừng\ngoi\ngọi\ngọi dừng\nhanh dong\nhành động\nquan tri\nquản trị\nquản trị gọi\nquản trị tắt\nquyen\nquyền\ntat\ntắt\nyeu cau\nyêu cầu",
          "zh-CN":
            "停止\n工具\n所有者\n拨打\n操作\n权限\n禁用\n策略\n管理员\n管理员 禁用\n管理员 通话\n角色\n请求\n通话\n通话 停止",
        },
      },
    },
    document: {
      request: {
        base: "action\naction list\naction provide\ndelete\ndelete document\ndelete import\ndelete_document\ndispatches\ndispatches document\ndocument\ndocument operations\ndocuments\ndocuments action\ndocuments document\ndocuments select\nedit\nedit delete\nedit document\nedit_document\nfields\nfile\nfile import\nimport\nimport file\nimport url\nimport_file\nimport_url\nknowledge document\nlist\nlist documents\nlist search\nlist_documents\nneeded\noperation\noperations\noperations using\nprovide\nread\nread document\nread write\nread_document\nsave document\nsave_document\nsearch\nsearch documents\nsearch read\nsearch_documents\nselect\nselect action\nstored\nstored documents\nsubaction\nsubaction list\nthat\nthat operation\nusing\nwrite\nwrite edit",
        locales: {
          es: "accion\naccion listar\narchivo\nborrar\nbuscar\nbuscar documento\nbuscar leer\nconocimiento\nconocimiento documento\ndocumento\ndocumento accion\ndocumento documento\ndocumento operacion\ndocumentos\neditar\neditar documento\neditar eliminar\neliminar\neliminar documento\nescribir\nescribir editar\nguardar notas\nhechos guardados\nherramienta\nleer\nleer documento\nleer escribir\nlistar\nlistar buscar\nlistar documento\nmostrar\nnotas\nnotas guardadas\noperacion\nrecordar\nsolicitud",
          ko: "검색\n검색 문서\n검색 읽기\n노트\n도구\n목록\n목록 검색\n목록 문서\n문서\n문서 문서\n문서 작업\n삭제\n삭제 문서\n쓰기\n쓰기 편집\n요청\n읽기\n읽기 문서\n읽기 쓰기\n작업\n작업 목록\n저장\n저장된 노트\n저장된 사실\n지식\n지식 문서\n파일\n파일 내용\n편집\n편집 문서\n편집 삭제\n회상",
          pt: "acao\nacao listar\napagar\narquivo\nbuscar\nbuscar documento\nbuscar ler\nconhecimento\nconhecimento documento\ndocumento\ndocumento acao\ndocumento documento\ndocumento operacao\ndocumentos\neditar\neditar documento\neditar excluir\nescrever\nescrever editar\nexcluir\nexcluir documento\nfatos salvos\nferramenta\nlembrar\nler\nler documento\nler escrever\nlistar\nlistar buscar\nlistar documento\nmostrar\nnotas\nnotas salvas\noperacao\nsalvar notas\nsolicitacao",
          tl: "aksyon\naksyon ilista\nalalahanin\nbasahin\nbasahin dokumento\nbasahin isulat\nburahin\nburahin dokumento\ndokumento\ndokumento aksyon\ndokumento dokumento\ndokumento operasyon\nfile\ni-edit\ni-edit burahin\ni-edit dokumento\ni-save\nilista\nilista dokumento\nilista maghanap\nisulat\nisulat i-edit\nkaalaman\nkaalaman dokumento\nkahilingan\nkasangkapan\nmaghanap\nmaghanap basahin\nmaghanap dokumento\nnilalaman ng file\nnotes\noperasyon\nsaved facts\nsaved notes",
          vi: "chinh sua\nchỉnh sửa\nchỉnh sửa tài liệu\nchỉnh sửa xóa\ncong cu\ncông cụ\ndoc\nđọc\nđọc tài liệu\nđọc viết\nghi chu\nghi chú\nghi chu da luu\nghi chú đã lưu\nhanh dong\nhành động\nhành động liệt kê\nkien thuc\nkiến thức\nkiến thức tài liệu\nliet ke\nliệt kê\nliệt kê tài liệu\nliệt kê tìm kiếm\nlưu ghi chú\nnhớ lại\ntai lieu\ntài liệu\ntài liệu hành động\ntài liệu tài liệu\ntài liệu thao tác\ntep\ntệp\nthao tac\nthao tác\ntim kiem\ntìm kiếm\ntìm kiếm đọc\ntìm kiếm tài liệu\nviet\nviết\nviết chỉnh sửa\nxoa\nxóa\nxóa tài liệu\nyeu cau\nyêu cầu",
          "zh-CN":
            "保存笔记\n写入\n写入 编辑\n列出\n列出 搜索\n列出 文档\n删除\n删除 文档\n回忆\n工具\n已保存事实\n已保存笔记\n搜索\n搜索 文档\n搜索 读取\n操作\n操作 列出\n文件\n文件内容\n文档\n文档 操作\n文档 文档\n知识\n知识 文档\n笔记\n编辑\n编辑 删除\n编辑 文档\n语义搜索\n请求\n读取\n读取 写入\n读取 文档",
        },
      },
    },
    doordash: {
      request: {
        base: "app\napp browser\napp turns\nauthenticate\nautomation doordash\nbound\nbrowser\nbrowser run\nbrowser user\nbrowser workspace\nbuilt\nbuilt browser\ncart\ncheckout\ncheckout history\ncloudflare\ncloudflare browser\nconfirmed\nconnectors doordash\ndash\ndelivery\ndoor\ndoordash\ndoordash cart\ndoordash_cart\neliza\neliza app\nfallback\nfood delivery\nfood doordash\nfood_delivery\ngeneral doordash\nhistory\nhistory delivery\nhistory order\nmenus\norder\norder food\norder tracking\norder_food\npreview\nrestaurant\nrestaurant search\nrun\nrun fallback\nsearch\nsearch menus\nsearch restaurants\nsearch_restaurants\nshopping doordash\ntrack doordash order\ntrack_doordash_order\ntracking\ntracking user\nturns\nturns browser\nunavailable\nunavailable app\nuser\nuser authenticate\nuser eliza\nworkspace\nworkspace unavailable",
        locales: {
          es: "accion\naplicacion\naplicacion navegador\napp\nautomatizacion\nbuscar\nchat general\nconector\nconversacion\ncron\ncuenta conectada\ndisparador\nejecutar\nespacio de trabajo\nflujo de trabajo\ngeneral\nhablar\nherramienta\nhistorial\nhistorial pedido\nintegracion\nmcp\nmonitor\nnavegador\nnavegador ejecutar\nnavegador espacio de trabajo\nnavegador usuario\noauth\norden\npedido\nrespuesta\nsolicitud\nusuario",
          ko: "검색\n계정 연결\n기록\n기록 주문\n답변\n도구\n말하기\n모니터\n브라우저\n브라우저 사용자\n브라우저 실행\n브라우저 작업공간\n사용자\n실행\n앱\n앱 브라우저\n오어스\n요청\n워크플로\n일반\n일반 대화\n자동화\n작업\n작업공간\n주문\n채팅\n커넥터\n크론\n통합\n트리거",
          pt: "acao\naplicativo\naplicativo navegador\napp\nautomacao\nbuscar\nchat geral\nconector\nconta conectada\nconversa\ncron\nespaco de trabalho\nexecutar\nfalar\nferramenta\nfluxo de trabalho\ngatilho\ngeral\nhistorico\nhistorico pedido\nintegracao\nmcp\nmonitor\nnavegador\nnavegador executar\nnavegador usuario\nnavegador workspace\noauth\npedido\nresposta\nsolicitacao\nusuario\nworkspace",
          tl: "account connection\naksyon\napp\napp browser\nautomation\nbrowser\nbrowser patakbuhin\nbrowser user\nbrowser workspace\nconnector\ncron\ngeneral chat\ngumagamit\nhistory\nhistory order\nintegration\nkahilingan\nkasangkapan\nmaghanap\nmakipag-usap\nmonitor\noauth\norder\npangkalahatan\npatakbuhin\nsagot\ntrigger\nusap\nuser\nworkflow\nworkspace",
          vi: "chay\nchạy\nchung\ncong cu\ncông cụ\ndon hang\nđơn hàng\nhanh dong\nhành động\nket noi\nkết nối\nkhong gian lam viec\nkhông gian làm việc\nkich hoat\nlich su\nlịch sử\nlịch sử đơn hàng\nnguoi dung\nngười dùng\nnói chuyện\noauth\nquy trinh\nquy trình\ntài khoản\ntich hop\ntích hợp\ntim kiem\ntìm kiếm\ntra loi\ntrả lời\ntrinh duyet\ntrình duyệt\ntrình duyệt chạy\ntrình duyệt không gian làm việc\ntrình duyệt người dùng\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\nung dung\nứng dụng\nứng dụng trình duyệt\nyeu cau\nyêu cầu",
          "zh-CN":
            "历史\n历史 订单\n回复\n回答\n定时\n对话\n工作区\n工作流\n工具\n应用\n应用 浏览器\n授权\n搜索\n操作\n普通聊天\n浏览器\n浏览器 工作区\n浏览器 用户\n浏览器 运行\n用户\n监控\n自动化\n触发器\n订单\n请求\n账号连接\n运行\n连接器\n通用\n集成",
        },
      },
    },
    draftPressRelease: {
      request: {
        base: "apps draft press release\nasks\nasks draft\ncloud\ncloud user\ncreate\ncreate draft\ncreate press release\ncreate_press_release\ndistribution\ndraft\ndraft pr\ndraft press\ndraft press release\ndraft save\ndraft_pr\ndraft_press_release\neliza\nlater\npress\nrelease\nsave\nsettings draft press release\nuser\nuser asks\nwrite press release\nwrite_press_release",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion borrador\napp\nborrador\nborrador pr\nconfiguracion\nconfiguracion borrador\ncrear\ncrear borrador\nescribir\nherramienta\nmodelo\npreferencias\npreguntar\npreguntar borrador\nsolicitud\nusuario\nusuario preguntar",
          ko: "구성\n도구\n모델 설정\n사용자\n사용자 질문\n생성\n생성 초안\n설정\n설정 초안\n쓰기\n앱\n앱 초안\n요청\n작업\n질문\n질문 초안\n초안\n초안 pr\n토글\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo rascunho\napp\nconfiguracao\nconfiguracoes\nconfiguracoes rascunho\ncriar\ncriar rascunho\nescrever\nferramenta\nmodelo\nperguntar\nperguntar rascunho\npreferencias\nrascunho\nrascunho pr\nsolicitacao\nusuario\nusuario perguntar",
          tl: "aksyon\napp\napp draft\nconfiguration\ndraft\ndraft pr\ngumagamit\ngumawa\ngumawa draft\nisulat\nkahilingan\nkasangkapan\nmagtanong\nmagtanong draft\nmodel settings\npreferences\nsettings\nsettings draft\ntoggle\nuser\nuser magtanong",
          vi: "ban nhap\nbản nháp\nbản nháp pr\ncai dat\ncài đặt\ncài đặt bản nháp\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nhỏi bản nháp\nnguoi dung\nngười dùng\nngười dùng hỏi\ntao\ntạo\ntạo bản nháp\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng bản nháp\nviet\nviết\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n写入\n创建\n创建 草稿\n工具\n应用\n应用 草稿\n开关\n操作\n模型设置\n用户\n用户 询问\n草稿\n草稿 pr\n设置\n设置 草稿\n询问\n询问 草稿\n请求\n配置",
        },
      },
    },
    duplicateAdCampaign: {
      request: {
        base: "advertising\napps duplicate ad campaign\ncampaign\ncampaign draft\nclone ad campaign\nclone_ad_campaign\ncloud\nconfig\ncopy\ncopy ad campaign\ncopy_ad_campaign\ncreatives\ncreatives draft\ndraft\ndraft copy\ndraft requires\nduplicate\nduplicate ad campaign\nduplicate_ad_campaign\nfinance duplicate ad campaign\nname\noptional\nrequires\nsets\nsettings duplicate ad campaign\nstructured",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\napp\nborrador\nconfiguracion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\nsaldo\nsolicitud",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n설정\n앱\n요청\n작업\n잔액\n청구서\n초안\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\napp\nconfiguracao\nconfiguracoes\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nportfolio\npreferencias\nrascunho\nsaldo\nsolicitacao",
          tl: "account\naksyon\napp\nbalance\nconfiguration\ndraft\nfinance\ninvoice\nkahilingan\nkasangkapan\nmodel settings\npera\nportfolio\npreferences\nsettings\ntoggle",
          vi: "ban nhap\nbản nháp\ncai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n开关\n投资组合\n操作\n模型设置\n草稿\n设置\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    edit: {
      request: {
        base: "ambiguous\nambiguous edits\nedit\nedits\nexact\nfails\nfile\nfile fails\npreviously\npreviously read\nread\nread file\nreplace\nstale\nstring",
        locales: {
          es: "accion\narchivo\neditar\nherramienta\nleer\nleer archivo\nsolicitud",
          ko: "도구\n요청\n읽기\n읽기 파일\n작업\n파일\n편집",
          pt: "acao\narquivo\neditar\nferramenta\nler\nler arquivo\nsolicitacao",
          tl: "aksyon\nbasahin\nbasahin file\nfile\ni-edit\nkahilingan\nkasangkapan",
          vi: "chinh sua\nchỉnh sửa\ncong cu\ncông cụ\ndoc\nđọc\nđọc tệp\nhanh dong\nhành động\ntep\ntệp\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n文件\n编辑\n请求\n读取\n读取 文件",
        },
      },
    },
    enableAutonomousMode: {
      request: {
        base: "admin\nadmin call\nadmin enable autonomous mode\nautonomous\nautonomy\ncall\ncall start\ncontinuous\nenable\nenable autonomous\nenable autonomous mode\nenable autonomy\nenable_autonomous_mode\nenable_autonomy\nloop\nmessaging enable autonomous mode\nmode\nowner\nowner admin\nstart\nstart autonomous mode\nstart autonomy\nstart_autonomous_mode\nstart_autonomy",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrador activar\nadministrador llamar\ndueño\nherramienta\nllamada\nllamar\npermisos\npolitica\nroles\nsolicitud",
          ko: "관리자\n관리자 통화\n관리자 활성화\n권한\n도구\n소유자\n역할\n요청\n작업\n전화\n정책\n통화\n활성화",
          pt: "acao\nadministrador\nadministrador ativar\nadministrador ligar\nativar\nchamada\ndono\nferramenta\nfuncoes\nligar\npermissoes\npolitica\nsolicitacao",
          tl: "admin\nadmin i-enable\nadmin tawag\naksyon\ni-enable\nkahilingan\nkasangkapan\nmay ari\npahintulot\npatakaran\nrole\ntawag",
          vi: "bat\nbật\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ngoi\ngọi\nhanh dong\nhành động\nquan tri\nquản trị\nquản trị bật\nquản trị gọi\nquyen\nquyền\nyeu cau\nyêu cầu",
          "zh-CN":
            "启用\n工具\n所有者\n拨打\n操作\n权限\n策略\n管理员\n管理员 启用\n管理员 通话\n角色\n请求\n通话",
        },
      },
    },
    entity: {
      request: {
        base: "add entity\nadd person\nadd_entity\nadd_person\nauthority\nauthority contact\ncadence\ncalendar entity\ncall\ncall text\nclaims\nconcepts\ncontact\ncontact crud\ncontact follow\ncontact identity\ncontacts\ncontacts entity\ncreate\ncreate read\ncrud\ncrud contact\ndated\ndated call\ndeterministic\nentity\nentity follow\nfollow\nfollow cadence\ngraph\nhistory\nhistory entity\nidentity\ninteraction\nlog interaction\nlog_interaction\nmemory entity\nmerge\nmerge contact\nmerge contacts\nmerge entities\nmerge_contacts\nmerge_entities\nmerges\nmessaging entity\norgs\nowner\nowner reminders\npeople\nprojects\nread\nread identity\nread relationship\nrelations\nrelations create\nrelationship\nrelationships\nrelationships create\nrelationships history\nreminders\nreminders owner\nrequire\nrolodex\nscheduled\nscheduled tasks\nset identity\nset_identity\ntasks\ntasks dated\ntasks entity\ntext\ntext reminders\ntyped",
        locales: {
          es: "accion\nagregar\namigo\nanadir\ncalendario\ncolega\ncontacto\ncontacto seguir\ncontactos\ncrear\ncrear leer\nfecha limite\ngente\nguardar memoria\nherramienta\nhistorial\nleer\nllamada\nllamar\nmemoria\npendiente\npersona\nrecordar\nrecordatorio\nrecuerdo\nrelacion\nseguimiento\nseguir\nsolicitud\ntarea\ntareas",
          ko: "관계\n기록\n기억\n기억해\n도구\n동료\n리마인더\n마감일\n사람\n생성\n생성 읽기\n알림\n연락처\n연락처 팔로우\n요청\n일정\n읽기\n작업\n장기 기억\n전화\n추가\n친구\n캘린더\n통화\n팔로우\n할 일\n회상\n후속 조치",
          pt: "acao\nacompanhamento\nadicionar\nafazer\namigo\ncalendario\nchamada\ncolega\ncontato\ncontato seguir\ncontatos\ncriar\ncriar ler\nferramenta\nhistorico\nlembrar\nlembrete\nler\nligar\nmemoria\npessoa\npessoas\nprazo\nrecordar\nrelacao\nsalvar memoria\nseguir\nsolicitacao\ntarefa\ntarefas",
          tl: "aksyon\nalaala\nalalahanin\nbasahin\ncontact\ncontact sundan\ncontacts\ndeadline\nfollow up\ngawain\ngumawa\ngumawa basahin\nhistory\nidagdag\nkahilingan\nkaibigan\nkalendaryo\nkasamahan\nkasangkapan\nlong term memory\nmemory\npaalala\nrelasyon\nsundan\ntandaan\ntao\ntask\ntawag\ntodo",
          vi: "cong cu\ncông cụ\ndoc\nđọc\nghi nho\nghi nhớ\ngoi\ngọi\nhanh dong\nhành động\nky uc\nký ức\nlich\nlịch\nlich su\nlịch sử\nlien he\nliên hệ\nliên hệ theo dõi\nnguoi\nngười\nnhac nho\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnho\nnhớ\nquan he\nquan hệ\ntac vu\ntác vụ\ntao\ntạo\ntạo đọc\nthem\nthêm\ntheo doi\ntheo dõi\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "人物\n任务\n关注\n关系\n创建\n创建 读取\n历史\n同事\n回忆\n工具\n待办\n截止日期\n拨打\n提醒\n操作\n日历\n朋友\n添加\n联系人\n联系人 关注\n记住\n记忆\n请求\n读取\n跟进\n通话\n长期记忆",
        },
      },
    },
    escalate: {
      request: {
        base: "action\naction admin\nadmin\nadmin escalate\nadmin owner\nadmin sends\nagent_internal escalate\nautonomous\nconfigured\nconfigured admin\ncontext\nescalate\nexplicit\nhuman\nhuman action\nmessaging escalate\nowner\nparty\nplugin\nplugin provides\nprovides\nresult\nreturn\nroute\nsend to admin\nsend_to_admin\nsends\nsends configured\ntarget\nthird\nunless\nunless plugin\nunsupported",
        locales: {
          es: "accion\naccion administrador\nadministrador\nadministrador enviar\nagente\ncomplemento\ndueño\nenviar\nenviar administrador\nestado interno\ngestion interna\nherramienta\ninterno del agente\npermisos\nplugin\npolitica\nroles\nsolicitud",
          ko: "관리자\n관리자 보내기\n권한\n내부 상태\n도구\n보내기\n보내기 관리자\n소유자\n에이전트\n에이전트 내부\n역할\n요청\n자체 관리\n작업\n작업 관리자\n정책\n플러그인",
          pt: "acao\nacao administrador\nadministrador\nadministrador enviar\nagente\ndono\nenviar\nenviar administrador\nestado interno\nferramenta\nfuncoes\ngestao interna\ninterno do agente\npermissoes\nplugin\npolitica\nsolicitacao",
          tl: "admin\nadmin ipadala\nagent\naksyon\naksyon admin\ninternal ng agent\ninternal state\nipadala\nipadala admin\nkahilingan\nkasangkapan\nmay ari\npahintulot\npatakaran\nplugin\nrole\nsariling pamamahala",
          vi: "chu so huu\nchủ sở hữu\ncong cu\ncông cụ\ngui\ngửi\ngửi quản trị\nhanh dong\nhành động\nhành động quản trị\nnoi bo tac tu\nnội bộ tác tử\nplugin\nquan tri\nquản trị\nquản trị gửi\nquyen\nquyền\ntac tu\ntác tử\ntu quan ly\ntự quản lý\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理内部\n内部状态\n发送\n发送 管理员\n工具\n所有者\n插件\n操作\n操作 管理员\n智能体\n权限\n策略\n管理员\n管理员 发送\n自我管理\n角色\n请求",
        },
      },
    },
    exportAdCampaignReport: {
      request: {
        base: "advertising\napps export ad campaign report\ncampaign\ncloud\ncreates\ncreates public\nexpiring\nexport\nexport ad campaign report\nexport_ad_campaign_report\nfinance export ad campaign report\nget ad campaign report\nget_ad_campaign_report\nlink\noptional\nperformance\npublic\nreport\nrequires\nsettings export ad campaign report\nshare\nshare ad campaign report\nshare_ad_campaign_report\nstructured\ntrue\ntrue creates",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\napp\nconfiguracion\ncrear\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nobtener\nportafolio\npreferencias\nsaldo\nsolicitud",
          ko: "가져오기\n계정\n구성\n금융\n도구\n돈\n모델 설정\n생성\n설정\n앱\n요청\n작업\n잔액\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\napp\nconfiguracao\nconfiguracoes\nconta\ncriar\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nobter\nportfolio\npreferencias\nsaldo\nsolicitacao",
          tl: "account\naksyon\napp\nbalance\nconfiguration\nfinance\ngumawa\ninvoice\nkahilingan\nkasangkapan\nkunin\nmodel settings\npera\nportfolio\npreferences\nsettings\ntoggle",
          vi: "cai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nlay\nlấy\nso du\nsố dư\ntai chinh\ntài chính\ntao\ntạo\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n创建\n发票\n工具\n应用\n开关\n投资组合\n操作\n模型设置\n获取\n设置\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    file: {
      request: {
        base: "absolute\naction\naction read\nautomation file\nbridge\ncode file\ndefaults\ndevice\nedit\nedit absolute\nedit file\nedit grep\nedit_file\nfile\nfile io\nfile list\nfile operation\nfile operations\nfile read\nfile_io\nfile_list\nfile_operation\nfile_read\nfiles\nfiles list\nfiles read\nfiles workspace\nfiles_list\nfiles_read\nglob\nglob list\ngrep\ngrep glob\nlist\nlist files\nlist_files\noperation\noperation defaults\noperations\noperations umbrella\noptional\npath\npaths\nread\nread file\nread write\nread_file\nsession\ntarget\nterminal file\numbrella\numbrella action\nunless\nunless operation\nuses\nworkspace\nworkspace paths\nwrite\nwrite edit\nwrite file\nwrite_file",
        locales: {
          es: "accion\naccion leer\narchivo\narchivo espacio de trabajo\narchivo leer\narchivo listar\narchivo operacion\nautomatizacion\nautomatizacion archivo\nbash\nbuscar texto\ncodigo\ncodigo archivo\ncron\ndepurar\ndisparador\neditar\neditar archivo\neditar buscar texto\nescribir\nescribir archivo\nescribir editar\nespacio de trabajo\nflujo de trabajo\ngrep\nherramienta\nimplementar\nleer\nleer archivo\nleer escribir\nlinea de comandos\nlistar\nlistar archivo\nmonitor\nmostrar\noperacion\nproceso\nprogramacion\nprueba\nrepositorio\nshell\nsolicitud\nterminal\nterminal archivo",
          ko: "grep\n구현\n도구\n디버그\n명령줄\n모니터\n목록\n목록 파일\n배시\n셸\n쓰기\n쓰기 파일\n쓰기 편집\n요청\n워크플로\n읽기\n읽기 쓰기\n읽기 파일\n자동화\n자동화 파일\n작업\n작업 읽기\n작업공간\n저장소\n코드\n코드 파일\n크론\n터미널\n터미널 파일\n테스트\n텍스트 검색\n트리거\n파일\n파일 목록\n파일 읽기\n파일 작업\n파일 작업공간\n편집\n편집 텍스트 검색\n편집 파일\n프로그래밍\n프로세스",
          pt: "acao\nacao ler\narquivo\narquivo ler\narquivo listar\narquivo operacao\narquivo workspace\nautomacao\nautomacao arquivo\nbash\nbuscar texto\ncodigo\ncodigo arquivo\ncron\ndepurar\neditar\neditar arquivo\neditar buscar texto\nescrever\nescrever arquivo\nescrever editar\nespaco de trabalho\nferramenta\nfluxo de trabalho\ngatilho\ngrep\nimplementar\nler\nler arquivo\nler escrever\nlinha de comando\nlistar\nlistar arquivo\nmonitor\nmostrar\noperacao\nprocesso\nprogramacao\nrepositorio\nshell\nsolicitacao\nterminal\nterminal arquivo\nteste\nworkspace",
          tl: "aksyon\naksyon basahin\nautomation\nautomation file\nbasahin\nbasahin file\nbasahin isulat\nbash\ncode\ncode file\ncommand line\ncron\ndebug\nfile\nfile basahin\nfile ilista\nfile operasyon\nfile workspace\ngrep\nhanapin text\ni-edit\ni-edit file\ni-edit hanapin text\nilista\nilista file\nipatupad\nisulat\nisulat file\nisulat i-edit\nkahilingan\nkasangkapan\nmonitor\noperasyon\nprocess\nprogramming\nrepo\nshell\nterminal\nterminal file\ntest\ntrigger\nworkflow\nworkspace",
          vi: "chinh sua\nchỉnh sửa\nchỉnh sửa tệp\nchỉnh sửa tìm văn bản\ncong cu\ncông cụ\nđọc tệp\nđọc viết\ndong lenh\ndòng lệnh\nhanh dong\nhành động\nhành động đọc\nkho ma\nkho mã\nkhong gian lam viec\nkhông gian làm việc\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nliet ke\nliệt kê\nliệt kê tệp\nma\nmã\nmã tệp\nquy trinh\nquy trình\nshell\ntệp đọc\ntệp không gian làm việc\ntệp liệt kê\ntệp thao tác\nterminal\nterminal tệp\nthao tac\nthao tác\ntiến trình\ntim van ban\ntìm văn bản\ntu dong hoa\ntự động hóa\ntự động hóa tệp\nviết chỉnh sửa\nviết tệp\nyeu cau\nyêu cầu",
          "zh-CN":
            "Bash\ngrep\n仓库\n代码\n代码 文件\n写入\n写入 文件\n写入 编辑\n列出\n列出 文件\n命令行\n定时\n实现\n工作区\n工作流\n工具\n操作\n操作 读取\n文件\n文件 列出\n文件 工作区\n文件 操作\n文件 读取\n文本搜索\n标准输出\n测试\n监控\n终端\n终端 文件\n编程\n编辑\n编辑 文件\n编辑 文本搜索\n自动化\n自动化 文件\n触发器\n请求\n读取\n读取 写入\n读取 文件\n调试\n进程",
        },
      },
    },
    files: {
      request: {
        base: "access\nagent_internal files\nbrowse files\nbrowse_files\nconfirm\ndelete\ndelete file\ndelete removes\ndelete requires\ndelete stored\ndelete_file\ndetails\ndetails served\ndocuments files\nevery\nfile\nfile details\nfile name\nfile optional\nfile requires\nfiles\nfiles delete\nfiles list\nfiles optional\nfind file\nfind_file\nget\nget delete\nget file\nget returns\nget_file\nlimit\nlimit get\nlist\nlist files\nlist get\nlist shows\nlist_files\nname\nname delete\noptional\noptional query\nquery\nquery get\nquery limit\nrecent\nrecent files\nrecent_files\nremove file\nremove_file\nremoves\nremoves file\nrequires\nreturns\nreturns file\nserved\nserved file\nshow files\nshow_files\nshows\nstored\nstored file\nstored files\ntrue",
        locales: {
          es: "accion\nagente\nagente archivo\narchivo\narchivo detalles\narchivo eliminar\narchivo listar\nborrar\nbuscar\nbuscar archivo\nconsulta\nconsulta obtener\ndetalles\ndocumento\ndocumento archivo\ndocumentos\neliminar\neliminar archivo\neliminar eliminar\nencontrar\nestado interno\ngestion interna\nguardar notas\nherramienta\ninterno del agente\nlistar\nlistar archivo\nlistar obtener\nmostrar\nnotas\nobtener\nobtener archivo\nobtener eliminar\nquitar\nsolicitud",
          ko: "가져오기\n가져오기 삭제\n가져오기 파일\n내부 상태\n노트\n도구\n목록\n목록 가져오기\n목록 파일\n문서\n문서 파일\n삭제\n삭제 제거\n삭제 파일\n세부정보\n에이전트\n에이전트 내부\n에이전트 파일\n요청\n자체 관리\n작업\n저장\n제거\n제거 파일\n질의\n찾기\n찾기 파일\n쿼리\n쿼리 가져오기\n파일\n파일 내용\n파일 목록\n파일 삭제\n파일 세부정보",
          pt: "acao\nagente\nagente arquivo\napagar\narquivo\narquivo detalhes\narquivo excluir\narquivo listar\nbuscar\nconsulta\nconsulta obter\ndetalhes\ndocumento\ndocumento arquivo\ndocumentos\nencontrar\nencontrar arquivo\nestado interno\nexcluir\nexcluir arquivo\nexcluir remover\nferramenta\ngestao interna\ninterno do agente\nlistar\nlistar arquivo\nlistar obter\nmostrar\nnotas\nobter\nobter arquivo\nobter excluir\nremover\nremover arquivo\nsalvar notas\nsolicitacao",
          tl: "agent\nagent file\naksyon\nalisin\nalisin file\nburahin\nburahin alisin\nburahin file\ndetalye\ndokumento\ndokumento file\nfile\nfile burahin\nfile detalye\nfile ilista\nhanapin\nhanapin file\ni-save\nilista\nilista file\nilista kunin\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nkunin\nkunin burahin\nkunin file\nnilalaman ng file\nnotes\nquery\nquery kunin\nsariling pamamahala",
          vi: "chi tiet\nchi tiết\ncong cu\ncông cụ\nghi chu\nghi chú\ngo\ngỡ\ngỡ tệp\nhanh dong\nhành động\nlay\nlấy\nlấy tệp\nlấy xóa\nliet ke\nliệt kê\nliệt kê lấy\nliệt kê tệp\nlưu ghi chú\nnoi bo tac tu\nnội bộ tác tử\ntac tu\ntác tử\ntác tử tệp\ntai lieu\ntài liệu\ntài liệu tệp\ntep\ntệp\ntệp chi tiết\ntệp liệt kê\ntệp xóa\ntim\ntìm\ntìm tệp\ntruy van\ntruy vấn\ntruy vấn lấy\ntu quan ly\ntự quản lý\nxoa\nxóa\nxóa gỡ\nxóa tệp\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 文件\n代理内部\n保存笔记\n内部状态\n列出\n列出 文件\n列出 获取\n删除\n删除 文件\n删除 移除\n工具\n操作\n文件\n文件 列出\n文件 删除\n文件 详情\n文件内容\n文档\n文档 文件\n智能体\n查找\n查找 文件\n查询\n查询 获取\n移除\n移除 文件\n笔记\n自我管理\n获取\n获取 删除\n获取 文件\n详情\n请求",
        },
      },
    },
    finish: {
      request: {
        base: "finish",
        locales: {
          es: "accion\nfinalizar\nherramienta\nsolicitud",
          ko: "도구\n완료\n요청\n작업",
          pt: "acao\nferramenta\nfinalizar\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan\ntapusin",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nket thuc\nkết thúc\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n结束\n请求",
        },
      },
    },
    form: {
      request: {
        base: "action\naction restore\nautomation form\ncontinue form\ncontinue_form\nform\nform restore\nform user\nform_restore\nmemory form\nmost\nrecent\nrehydrates\nrestore\nresume form\nresume_form\nrouter\nrouter action\nsession\nstashed\ntasks form\nuser",
        locales: {
          es: "accion\nautomatizacion\ncron\ndisparador\nfecha limite\nflujo de trabajo\nguardar memoria\nherramienta\nmemoria\nmonitor\npendiente\nrecordar\nrecordatorio\nrecuerdo\nseguimiento\nsolicitud\ntarea\ntareas\nusuario",
          ko: "기억\n기억해\n도구\n리마인더\n마감일\n모니터\n사용자\n요청\n워크플로\n자동화\n작업\n장기 기억\n크론\n트리거\n할 일\n회상\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\nautomacao\ncron\nferramenta\nfluxo de trabalho\ngatilho\nlembrar\nlembrete\nmemoria\nmonitor\nprazo\nrecordar\nsalvar memoria\nsolicitacao\ntarefa\ntarefas\nusuario",
          tl: "aksyon\nalaala\nalalahanin\nautomation\ncron\ndeadline\nfollow up\ngawain\ngumagamit\nkahilingan\nkasangkapan\nlong term memory\nmemory\nmonitor\npaalala\ntandaan\ntask\ntodo\ntrigger\nuser\nworkflow",
          vi: "cong cu\ncông cụ\nghi nho\nghi nhớ\nhanh dong\nhành động\nkich hoat\nky uc\nký ức\nnguoi dung\nngười dùng\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnho\nnhớ\nquy trinh\nquy trình\ntac vu\ntác vụ\ntu dong hoa\ntự động hóa\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "任务\n回忆\n定时\n工作流\n工具\n待办\n截止日期\n提醒\n操作\n用户\n监控\n自动化\n触发器\n记住\n记忆\n请求\n跟进\n长期记忆",
        },
      },
    },
    generateMedia: {
      request: {
        base: "appropriate\naudio\naudio video\nbackend\ncleanly\ncreate image\ncreate_image\ndraw image\ndraw_image\ngenerate\ngenerate audio\ngenerate image\ngenerate media\ngenerate video\ngenerate_audio\ngenerate_media\ngenerate_video\nimage\nimage audio\nimage text\nlanguage\nlocal\nmake picture\nmake_picture\nmedia\nmedia image\nmodel\nnatural\nprompt\nrefusal\nrefused\nregistry\nregistry video\nrender image\nrender_image\nroutes\nroutes image\nruntime\nsay aloud\nsay_aloud\nspeak\nspeech\ntext\ntext to speech\ntext_to_speech\nunavailable\nvideo\nvideo natural\nvideo refusal\nvideo unavailable\ncreate media\nmake media\ncreate video\nanimate\nanimation\ncreate audio\ngenerate music\nsound effect\ntts\nvoiceover",
        locales: {
          es: "accion\naudio\naudio video\ncrear\ncrear imagen\nfoto\ngenerar\ngenerar audio\ngenerar imagen\ngenerar multimedia\ngenerar video\nherramienta\nimagen\nimagen audio\nmultimedia\nmultimedia imagen\nsolicitud\nvideo\ngenerar media\ncrear media\ncrear video\nanimar\ncrear audio\ntexto a voz",
          ko: "도구\n미디어\n미디어 이미지\n비디오\n사진\n생성\n생성 미디어\n생성 비디오\n생성 오디오\n생성 이미지\n영상\n오디오\n오디오 비디오\n요청\n이미지\n이미지 오디오\n작업\n미디어 생성\n이미지 생성\n비디오 생성\n영상 생성\n애니메이션\n오디오 생성\n음악 생성\n텍스트 음성 변환",
          pt: "acao\naudio\naudio video\ncriar\ncriar imagem\nferramenta\nfoto\ngerar\ngerar audio\ngerar imagem\ngerar midia\ngerar video\nimagem\nimagem audio\nmidia\nmidia imagem\nsolicitacao\nvideo\ngerar mídia\ncriar mídia\ncriar midia\ngerar vídeo\nanimar\ngerar áudio\ntexto para fala",
          tl: "aksyon\naudio\naudio video\nbumuo\nbumuo audio\nbumuo larawan\nbumuo media\nbumuo video\ngumawa\ngumawa larawan\nkahilingan\nkasangkapan\nlarawan\nlarawan audio\nmedia\nmedia larawan\nvideo\ngumawa ng media\nlumikha ng media\ngumawa ng larawan\ngumawa ng video\ni-animate\ngumawa ng audio\ntext to speech",
          vi: "am thanh\nâm thanh\nâm thanh video\nanh\nảnh\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nđa phương tiện hình ảnh\nhanh dong\nhành động\nhinh anh\nhình ảnh\nhình ảnh âm thanh\ntao\ntạo\ntạo âm thanh\ntạo đa phương tiện\ntạo hình ảnh\ntạo video\nvideo\nyeu cau\nyêu cầu\ntạo media\ntao media\ntạo ảnh\ntao anh\ntao video\nhoạt hình\nhoat hinh\ntao am thanh\nvăn bản thành giọng nói",
          "zh-CN":
            "创建\n创建 图片\n图像\n图片\n图片 音频\n媒体\n媒体 图片\n工具\n操作\n生成\n生成 图片\n生成 媒体\n生成 视频\n生成 音频\n视频\n请求\n音频\n音频 视频\n生成媒体\n创建媒体\n生成图片\n生成视频\n动画\n生成音频\n音乐\n文字转语音",
        },
      },
    },
    getAdCampaignAttribution: {
      request: {
        base: "advertising\napps get ad campaign attribution\ncampaign\ncloud\nconversion\neliza\nfetch\nfinance get ad campaign attribution\nget ad campaign attribution\nget attribution pixel\nget campaign webhook\nget conversion pixel\nget_ad_campaign_attribution\nget_attribution_pixel\nget_campaign_webhook\nget_conversion_pixel\ninstall\ninstall conversion tracking\ninstall instructions\ninstall_conversion_tracking\ninstructions\npixel\nsettings get ad campaign attribution\nsigned\nwebhook\nwebhook install",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion obtener\napp\nconfiguracion\nconfiguracion obtener\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\ninstalar\nmodelo\nobtener\nportafolio\npreferencias\nsaldo\nsolicitud",
          ko: "가져오기\n계정\n구성\n금융\n도구\n돈\n모델 설정\n설정\n설정 가져오기\n설치\n앱\n앱 가져오기\n요청\n작업\n잔액\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo obter\napp\nconfiguracao\nconfiguracoes\nconfiguracoes obter\nconta\ndinheiro\nfatura\nferramenta\nfinancas\ninstalar\nmodelo\nobter\nportfolio\npreferencias\nsaldo\nsolicitacao",
          tl: "account\naksyon\napp\napp kunin\nbalance\nconfiguration\nfinance\ni-install\ninvoice\nkahilingan\nkasangkapan\nkunin\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings kunin\ntoggle",
          vi: "cai dat\ncài đặt\ncài đặt lấy\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nlay\nlấy\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng lấy\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n安装\n工具\n应用\n应用 获取\n开关\n投资组合\n操作\n模型设置\n获取\n设置\n设置 获取\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    getApp: {
      request: {
        base: "app\napp details\napp info\napp name\napp user\napp_details\napp_info\napps get app\nasks\nasks particular\ncloud\ncloud app\ncredits\ndeployment\ndeployment status\ndescribe app\ndescribe_app\ndetails\ndetails eliza\ndetails specific\nearnings\nearnings users\neliza\nfinance get app\nget app\nget_app\nname\nowns\nparticular\nparticular app\nsettings get app\nshow\nshow app\nshow details\nshow_app\nspecific\nstatus\nstatus credits\ntell me about app\ntell_me_about_app\nused\nuser\nuser asks\nuser owns\nusers\nusers user",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion detalles\naplicacion obtener aplicacion\naplicacion usuario\napp\nconfiguracion\nconfiguracion obtener aplicacion\ncuenta\ndescribir\ndescribir aplicacion\ndetalles\ndinero\nestado\nfactura\nfinanzas\nherramienta\nmodelo\nobtener\nobtener aplicacion\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar\nusuario usuario",
          ko: "가져오기\n가져오기 앱\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 사용자\n사용자 질문\n상태\n설명\n설명 앱\n설정\n설정 가져오기 앱\n세부정보\n앱\n앱 가져오기 앱\n앱 사용자\n앱 세부정보\n요청\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo detalhes\naplicativo obter aplicativo\naplicativo usuario\napp\nconfiguracao\nconfiguracoes\nconfiguracoes obter aplicativo\nconta\ndescrever\ndescrever aplicativo\ndetalhes\ndinheiro\nestado\nfatura\nferramenta\nfinancas\nmodelo\nobter\nobter aplicativo\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nstatus\nusuario\nusuario perguntar\nusuario usuario",
          tl: "account\naksyon\napp\napp detalye\napp kunin app\napp user\nbalance\nconfiguration\ndetalye\nfinance\ngumagamit\nilarawan\nilarawan app\ninvoice\nkahilingan\nkasangkapan\nkunin\nkunin app\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings kunin app\nstatus\ntoggle\nuser\nuser magtanong\nuser user",
          vi: "cai dat\ncài đặt\ncài đặt lấy ứng dụng\ncấu hình\nchi tiet\nchi tiết\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nlay\nlấy\nlấy ứng dụng\nmo ta\nmô tả\nmô tả ứng dụng\nnguoi dung\nngười dùng\nngười dùng hỏi\nngười dùng người dùng\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntrang thai\ntrạng thái\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng chi tiết\nứng dụng lấy ứng dụng\nứng dụng người dùng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 用户\n应用 获取 应用\n应用 详情\n开关\n投资组合\n描述\n描述 应用\n操作\n模型设置\n状态\n用户\n用户 用户\n用户 询问\n获取\n获取 应用\n设置\n设置 获取 应用\n询问\n详情\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    getAppDeployStatus: {
      request: {
        base: "app\napp deploy\napp deploy status\napp draft\napp live\napp_deploy_status\napps get app deploy status\nasks\nasks whether\nbuilding\ncloud\ncloud app\ndeploy\ndeploy status\ndeploy_status\ndeployed\ndeployment\ndeployment status\ndone\ndraft\ndraft building\neliza\nfailed\nfailed user\nfinance get app deploy status\nget app deploy status\nget_app_deploy_status\nis app deployed\nis my app live\nis_app_deployed\nis_my_app_live\nlive\nreport\nreport app\nsettings get app deploy status\nstatus\nstatus draft\nstatus eliza\nuser\nuser asks\nwhether\nwhether app",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion borrador\naplicacion estado\naplicacion obtener aplicacion estado\napp\nborrador\nconfiguracion\nconfiguracion obtener aplicacion estado\ncuenta\ndinero\nestado\nestado borrador\nfactura\nfinanzas\nherramienta\nmodelo\nobtener\nobtener aplicacion estado\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "가져오기\n가져오기 앱 상태\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n상태\n상태 초안\n설정\n설정 가져오기 앱 상태\n앱\n앱 가져오기 앱 상태\n앱 상태\n앱 초안\n요청\n작업\n잔액\n질문\n청구서\n초안\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo obter aplicativo status\naplicativo rascunho\naplicativo status\napp\nconfiguracao\nconfiguracoes\nconfiguracoes obter aplicativo status\nconta\ndinheiro\nestado\nfatura\nferramenta\nfinancas\nmodelo\nobter\nobter aplicativo status\nperguntar\nportfolio\npreferencias\nrascunho\nsaldo\nsolicitacao\nstatus\nstatus rascunho\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp draft\napp kunin app status\napp status\nbalance\nconfiguration\ndraft\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkunin\nkunin app status\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings kunin app status\nstatus\nstatus draft\ntoggle\nuser\nuser magtanong",
          vi: "ban nhap\nbản nháp\ncai dat\ncài đặt\ncài đặt lấy ứng dụng trạng thái\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nlay\nlấy\nlấy ứng dụng trạng thái\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntrang thai\ntrạng thái\ntrạng thái bản nháp\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng bản nháp\nứng dụng lấy ứng dụng trạng thái\nứng dụng trạng thái\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 状态\n应用 草稿\n应用 获取 应用 状态\n开关\n投资组合\n操作\n模型设置\n状态\n状态 草稿\n用户\n用户 询问\n草稿\n获取\n获取 应用 状态\n设置\n设置 获取 应用 状态\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    getAppEarnings: {
      request: {
        base: "amount\napp\napp earned\napp earnings\napp revenue\napp_earnings\napps get app earnings\nasks\nasks much\nbalance\nbalance lifetime\nbalance pending\ncheck earnings\ncheck_earnings\ncloud\ncloud app\nearned\nearned app\nearnings\nearnings read\neliza\nfinance get app earnings\nget app earnings\nget_app_earnings\nhow much have i earned\nhow_much_have_i_earned\nlifetime\nmuch\nmy earnings\nmy_earnings\nonly\nonly user\npending\npending balance\nread\nread only\nrevenue\nsettings get app earnings\nshow\nshow earnings\nshow_earnings\nthey\nuser\nuser asks\nwithdrawable\nwithdrawable balance\nwithdrawn\nwithdrawn read",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion obtener aplicacion\napp\ncomprobar\nconfiguracion\nconfiguracion obtener aplicacion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nleer\nmodelo\nobtener\nobtener aplicacion\nportafolio\npreferencias\npreguntar\nrevisar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "가져오기\n가져오기 앱\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 가져오기 앱\n앱\n앱 가져오기 앱\n요청\n읽기\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n확인\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo obter aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes obter aplicativo\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nler\nmodelo\nobter\nobter aplicativo\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar\nverificar",
          tl: "account\naksyon\napp\napp kunin app\nbalance\nbasahin\nconfiguration\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkunin\nkunin app\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings kunin app\nsuriin\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt lấy ứng dụng\ncấu hình\ncong cu\ncông cụ\ndoc\nđọc\nhanh dong\nhành động\nhoi\nhỏi\nkiem tra\nkiểm tra\nlay\nlấy\nlấy ứng dụng\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng lấy ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 获取 应用\n开关\n投资组合\n操作\n检查\n模型设置\n用户\n用户 询问\n获取\n获取 应用\n设置\n设置 获取 应用\n询问\n请求\n读取\n财务\n账户\n配置\n钱",
        },
      },
    },
    getCompanionStatus: {
      request: {
        base: "capabilities\ncompanion\nconnection\ndevice\ndevice status\ndisconnected\nfails\nfirmware\nget companion status\nget_companion_status\nmood\nread\nread companion\nstate\nstatus\nstatus device",
        locales: {
          es: "accion\nestado\nherramienta\nleer\nobtener\nobtener estado\nsolicitud",
          ko: "가져오기\n가져오기 상태\n도구\n상태\n요청\n읽기\n작업",
          pt: "acao\nestado\nferramenta\nler\nobter\nobter status\nsolicitacao\nstatus",
          tl: "aksyon\nbasahin\nkahilingan\nkasangkapan\nkunin\nkunin status\nstatus",
          vi: "cong cu\ncông cụ\ndoc\nđọc\nhanh dong\nhành động\nlay\nlấy\nlấy trạng thái\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n状态\n获取\n获取 状态\n请求\n读取",
        },
      },
    },
    getMeetingTranscript: {
      request: {
        base: "attended\nfinal\nget meeting transcript\nget_meeting_transcript\nlive\nmeeting\nmeeting notes\nmeeting_notes\nnotetaker\nretrieve\nshow meeting transcript\nshow_meeting_transcript\ntranscript",
        locales: {
          es: "accion\nherramienta\nobtener\nsolicitud",
          ko: "가져오기\n도구\n요청\n작업",
          pt: "acao\nferramenta\nobter\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan\nkunin",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nlay\nlấy\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n获取\n请求",
        },
      },
    },
    getOmarchyStatus: {
      request: {
        base: "desktop\ndesktop status\neliza\nget omarchy status\nget_omarchy_status\ninventory\ninventory eliza\nomarchy\nomarchy desktop\nplugin\nplugin inventory\nplugin state\nread\nread omarchy\nshell\nshell plugin\nstate\nstatus\ntheme\nversion",
        locales: {
          es: "accion\ncomplemento\nescritorio\nescritorio estado\nestado\nherramienta\ninventario\nleer\nobtener\nobtener estado\nplugin\nplugin inventario\nsolicitud",
          ko: "가져오기\n가져오기 상태\n데스크톱\n데스크톱 상태\n도구\n상태\n요청\n읽기\n작업\n재고\n플러그인\n플러그인 재고",
          pt: "acao\narea de trabalho\narea de trabalho status\nestado\nestoque\nferramenta\ninventario\nler\nobter\nobter status\nplugin\nplugin inventario\nsolicitacao\nstatus",
          tl: "aksyon\nbasahin\ndesktop\ndesktop status\nimbentaryo\nkahilingan\nkasangkapan\nkunin\nkunin status\nplugin\nplugin imbentaryo\nstatus",
          vi: "cong cu\ncông cụ\ndoc\nđọc\nhang ton kho\nhàng tồn kho\nhanh dong\nhành động\nlay\nlấy\nlấy trạng thái\nmay tinh de ban\nmáy tính để bàn\nmáy tính để bàn trạng thái\nplugin\nplugin hàng tồn kho\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu",
          "zh-CN":
            "工具\n库存\n插件\n插件 库存\n操作\n桌面\n桌面 状态\n状态\n获取\n获取 状态\n请求\n读取",
        },
      },
    },
    github: {
      request: {
        base: "action\naction list\nassign\nassign issue\nautomation github\nclose\nclose issue\ncode github\ncomment\ncomment issue\ncomment label\nconnectors github\ncreate\ncreate assign\ncreate issue\ngithub\ngithub issue\ngithub issue op\ngithub notification triage\ngithub notifications\ngithub pr op\ngithub pull request\ngithub_issue\ngithub_issue_op\ngithub_notification_triage\ngithub_notifications\ngithub_pr_op\ngithub_pull_request\nissue\nissue assign\nissue close\nissue comment\nissue create\nissue label\nissue reopen\nissues\nissues notification\nlabel\nlist\nlist review\nnotification\npull\npull requests\nreopen\nreopen comment\nreopen issue\nrequests\nrequests issues\nreview\nreview issue\ntasks github\ntriage\ntriage action\numbrella",
        locales: {
          es: "accion\naccion listar\nautomatizacion\nautomatizacion github\ncodigo\ncodigo github\ncomentario\ncomentario incidencia\nconector\nconector github\ncrear\ncrear incidencia\ncron\ncuenta conectada\ndepurar\ndisparador\nfecha limite\nflujo de trabajo\ngithub incidencia\ngithub solicitud\nherramienta\nimplementar\nincidencia\nincidencia comentario\nincidencia crear\nintegracion\nlistar\nmcp\nmonitor\nmostrar\noauth\npedir\npendiente\nprogramacion\nprueba\nrecordatorio\nrepositorio\nseguimiento\nsolicitud\nsolicitud incidencia\ntarea\ntarea github\ntareas",
          ko: "github 요청\ngithub 이슈\n계정 연결\n구현\n댓글\n댓글 이슈\n도구\n디버그\n리마인더\n마감일\n모니터\n목록\n생성\n생성 이슈\n오어스\n요청\n요청 이슈\n워크플로\n이슈\n이슈 댓글\n이슈 생성\n자동화\n자동화 github\n작업\n작업 github\n작업 목록\n저장소\n커넥터\n커넥터 github\n코드\n코드 github\n크론\n테스트\n통합\n트리거\n프로그래밍\n할 일\n후속 조치",
          pt: "acao\nacao listar\nacompanhamento\nafazer\nautomacao\nautomacao github\ncodigo\ncodigo github\ncomentario\ncomentario problema\nconector\nconector github\nconta conectada\ncriar\ncriar problema\ncron\ndepurar\nferramenta\nfluxo de trabalho\ngatilho\ngithub problema\ngithub solicitacao\nimplementar\nintegracao\nissue\nlembrete\nlistar\nmcp\nmonitor\nmostrar\noauth\npedir\nprazo\nproblema\nproblema comentario\nproblema criar\nprogramacao\nrepositorio\nsolicitacao\nsolicitacao problema\ntarefa\ntarefa github\ntarefas\nteste",
          tl: "account connection\naksyon\naksyon ilista\nautomation\nautomation github\ncode\ncode github\nconnector\nconnector github\ncron\ndeadline\ndebug\nfollow up\ngawain\ngawain github\ngithub isyu\ngithub kahilingan\ngumawa\ngumawa isyu\nhiling\nilista\nintegration\nipatupad\nisyu\nisyu gumawa\nisyu komento\nkahilingan\nkahilingan isyu\nkasangkapan\nkomento\nkomento isyu\nmonitor\noauth\npaalala\nprogramming\nrepo\ntask\ntest\ntodo\ntrigger\nworkflow",
          vi: "binh luan\nbình luận\nbình luận vấn đề\ncong cu\ncông cụ\ngithub vấn đề\ngithub yêu cầu\nhanh dong\nhành động\nhành động liệt kê\nket noi\nkết nối\nkết nối github\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nliet ke\nliệt kê\nma\nmã\nmã github\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnhiệm vụ github\nquy trinh\nquy trình\ntac vu\ntác vụ\ntài khoản\ntạo vấn đề\ntich hop\ntích hợp\ntu dong hoa\ntự động hóa\ntự động hóa github\nvan de\nvấn đề\nvấn đề bình luận\nvấn đề tạo\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu\nyêu cầu vấn đề",
          "zh-CN":
            "github 请求\ngithub 问题\n仓库\n代码\n代码 github\n任务\n任务 github\n列出\n创建\n创建 问题\n定时\n实现\n工作流\n工具\n待办\n截止日期\n授权\n提醒\n操作\n操作 列出\n测试\n监控\n编程\n自动化\n自动化 github\n触发器\n评论\n评论 问题\n请求\n请求 问题\n调试\n账号连接\n跟进\n连接器\n连接器 github\n问题\n问题 创建\n问题 评论\n集成",
        },
      },
    },
    identifySpeaker: {
      request: {
        base: "agent\nagent recognizes\nattach\nfriend\nheard\nidentify speaker\nidentify_speaker\njill\nmost\nname\nname speaker\nname_speaker\nowner\nperson\nrecent\nrecently\nrecognizes\nremember voice\nremember_voice\nsays\nsessions\nspeaker\nstill\ntag voice\ntag_voice\nthat\nthis is speaker\nthis_is_speaker\nunidentified\nvoice\nvoice agent",
        locales: {
          es: "accion\nagente\nherramienta\nidentificar\nsolicitud",
          ko: "도구\n식별\n에이전트\n요청\n작업",
          pt: "acao\nagente\nferramenta\nidentificar\nsolicitacao",
          tl: "agent\naksyon\nkahilingan\nkasangkapan\ntukuyin",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nnhan dang\nnhận dạng\ntac tu\ntác tử\nyeu cau\nyêu cầu",
          "zh-CN": "代理\n工具\n操作\n智能体\n识别\n请求",
        },
      },
    },
    joinMeeting: {
      request: {
        base: "agent\napp\nattend\nattend meeting\nattend_meeting\ncalendar\ncall\ncontains\ncover\ngoogle\ninvite to meeting\ninvite_to_meeting\njoin\njoin call\njoin meeting\njoin_call\njoin_meeting\nlink\nlive\nmeet\nmeeting\nmessage\nmicrosoft\nnotes\nnotetaker\nover\nprefer\nreal\nrecord\nrecord meeting\nrecord_meeting\nreminder\nsend\nsend notetaker\nsend_notetaker\ntake\ntake meeting notes\ntake_meeting_notes\nteams\nthat\ntime\ntranscribe\ntranscribe meeting\ntranscribe_meeting\nuser\nwants\nwhenever\nzoom",
        locales: {
          es: "accion\nagente\naplicacion\napp\ncalendario\nenviar\nherramienta\nllamada\nllamar\nmensaje\nrecordatorio\nsolicitud\nusuario",
          ko: "도구\n리마인더\n메시지\n보내기\n사용자\n알림\n앱\n에이전트\n요청\n일정\n작업\n전화\n캘린더\n통화",
          pt: "acao\nagente\naplicativo\napp\ncalendario\nchamada\nenviar\nferramenta\nlembrete\nligar\nmensagem\nsolicitacao\nusuario",
          tl: "agent\naksyon\napp\ngumagamit\nipadala\nkahilingan\nkalendaryo\nkasangkapan\nmensahe\npaalala\ntawag\nuser",
          vi: "cong cu\ncông cụ\ngoi\ngọi\ngui\ngửi\nhanh dong\nhành động\nlich\nlịch\nnguoi dung\nngười dùng\nnhac nho\nnhắc nhở\ntac tu\ntác tử\ntin nhan\ntin nhắn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n发送\n工具\n应用\n拨打\n提醒\n操作\n日历\n智能体\n消息\n用户\n请求\n通话",
        },
      },
    },
    leaveMeeting: {
      request: {
        base: "attending\ncurrently\nexit meeting\nexit_meeting\nfinalize\nleave\nleave meeting\nleave_meeting\nmeeting\nnotetaker\nstop meeting transcription\nstop_meeting_transcription\ntranscript",
        locales: {
          es: "accion\ndetener\nherramienta\nparar\nsolicitud",
          ko: "도구\n요청\n작업\n중지",
          pt: "acao\nferramenta\nparar\nsolicitacao",
          tl: "aksyon\nitigil\nkahilingan\nkasangkapan",
          vi: "cong cu\ncông cụ\ndung\ndừng\nhanh dong\nhành động\nyeu cau\nyêu cầu",
          "zh-CN": "停止\n工具\n操作\n请求",
        },
      },
    },
    linear: {
      request: {
        base: "action\naction requested\nassigned\nassigned issues\nassigned user\ndetail\ninspect\ninspect issue\nissue\nissue detail\nissue list\nissue tracker\nissue_tracker\nissues\nissues assigned\nissues inspect\nissues workspace\nknown\nlinear\nlinear action\nlinear issues\nlinear_issues\nlist\nlist teams\nlook\nlook linear\noperation\noperation known\nproductivity linear\npromoted\npromoted linear\nrequested\nrequested operation\nsearch\nsearch issue\nsearch workspace\nspecific\nsprint\nteams\nuser\nuser search\nwork linear\nwork tracking\nwork_tracking\nworkspace\nworkspace issues\nworkspace search",
        locales: {
          es: "accion\nbuscar\nbuscar espacio de trabajo\nbuscar incidencia\nespacio de trabajo\nespacio de trabajo buscar\nespacio de trabajo incidencia\nherramienta\nincidencia\nincidencia espacio de trabajo\nincidencia listar\nlinear\nlinear accion\nlinear incidencia\nlistar\nmostrar\noperacion\nplan de trabajo\nplanificacion\nprioridades\nproductividad\nsolicitud\ntarea\nusuario\nusuario buscar",
          ko: "검색\n검색 이슈\n검색 작업공간\n계획\n도구\n리니어\n리니어 이슈\n리니어 작업\n목록\n사용자\n사용자 검색\n생산성\n업무 계획\n요청\n우선순위\n이슈\n이슈 목록\n이슈 작업공간\n작업\n작업공간\n작업공간 검색\n작업공간 이슈",
          pt: "acao\nbuscar\nbuscar problema\nbuscar workspace\nespaco de trabalho\nferramenta\nissue\nlinear\nlinear acao\nlinear problema\nlistar\nmostrar\noperacao\nplanejamento\nplano de trabalho\nprioridades\nproblema\nproblema listar\nproblema workspace\nprodutividade\nsolicitacao\nusuario\nusuario buscar\nworkspace\nworkspace buscar\nworkspace problema",
          tl: "aksyon\ngumagamit\nilista\nisyu\nisyu ilista\nisyu workspace\nkahilingan\nkasangkapan\nlinear\nlinear aksyon\nlinear isyu\nmaghanap\nmaghanap isyu\nmaghanap workspace\noperasyon\npagpaplano\nprayoridad\nproductivity\nuser\nuser maghanap\nwork plan\nworkspace\nworkspace isyu\nworkspace maghanap",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nkhong gian lam viec\nkhông gian làm việc\nkhông gian làm việc tìm kiếm\nkhông gian làm việc vấn đề\nlap ke hoach\nlập kế hoạch\nliet ke\nliệt kê\nlinear\nlinear hành động\nlinear vấn đề\nnang suat\nnăng suất\nnguoi dung\nngười dùng\nngười dùng tìm kiếm\nthao tac\nthao tác\ntim kiem\ntìm kiếm\ntìm kiếm không gian làm việc\ntìm kiếm vấn đề\nưu tiên\nvan de\nvấn đề\nvấn đề không gian làm việc\nvấn đề liệt kê\nyeu cau\nyêu cầu",
          "zh-CN":
            "linear\nlinear 操作\nlinear 问题\n优先级\n列出\n工作区\n工作区 搜索\n工作区 问题\n工作计划\n工具\n搜索\n搜索 工作区\n搜索 问题\n操作\n效率\n用户\n用户 搜索\n规划\n请求\n问题\n问题 列出\n问题 工作区",
        },
      },
    },
    liquidity: {
      request: {
        base: "action\naction action\naction chain\naction onboard\naerodrome\namount\nautomate positions\nautomate raydium positions\nautomate raydium rebalancing\nautomate rebalancing\nautomate_positions\nautomate_raydium_positions\nautomate_raydium_rebalancing\nautomate_rebalancing\nautomation liquidity\nchain\nclose\ncrypto liquidity\nfilters\nfinance liquidity\nget\nget position\ninferred\ninferred omitted\nliquidity\nliquidity management\nliquidity pool management\nliquidity_pool_management\nlist\nlist pools\nlist positions\nlp management\nlp manager\nlp_management\nlp_manager\nmanage\nmanage liquidity\nmanage lp\nmanage lp positions\nmanage positions\nmanage raydium positions\nmanage_liquidity\nmanage_lp\nmanage_lp_positions\nmanage_positions\nmanage_raydium_positions\nmanagement\nmanagement action\nmeteora\nomitted\nonboard\nonboard list\nopen\nopen close\norca\npancakeswap\npool\npools\npools open\nposition\npositions\npositions action\npositions get\npreferences\nprotocol\nrange\nrange token\nraydium\nreposition\nreposition list\nselects\nsingle\nsolana\nsolana inferred\nstart managing positions\nstart managing raydium positions\nstart_managing_positions\nstart_managing_raydium_positions\ntoken\ntoken filters\nuniswap\nwallet liquidity",
        locales: {
          es: "abrir\naccion\naccion accion\nadministrar\nautomatizacion\nbilletera\ncadena\ncripto\ncron\ncuenta\ndefi\ndinero\ndireccion\ndisparador\nfactura\nfinanzas\nfirmar transaccion\nflujo de trabajo\ngestion\ngestion accion\ngestionar\nherramienta\ninferido\nintercambio\nliquidez\nlistar\nmonitor\nmostrar\nobtener\nportafolio\nsaldo\nsolicitud\ntoken\ntransferir",
          ko: "가져오기\n거래 서명\n계정\n관리\n관리 작업\n금융\n도구\n돈\n디파이\n모니터\n목록\n스왑\n암호화폐\n열기\n온체인\n요청\n워크플로\n유동성\n자동화\n작업\n작업 작업\n잔액\n전송\n주소\n지갑\n청구서\n추론\n크론\n토큰\n트리거\n포트폴리오",
          pt: "abrir\nacao\nacao acao\nassinar transacao\nautomacao\ncarteira\nconta\ncripto\ncron\ndefi\ndinheiro\nendereco\nfatura\nferramenta\nfinancas\nfluxo de trabalho\ngatilho\ngerenciamento\ngerenciamento acao\ngerenciar\ninferido\nliquidez\nlistar\nmonitor\nmostrar\nobter\nonchain\nportfolio\nsaldo\nsolicitacao\ntoken\ntransferir\ntroca",
          tl: "account\naddress\naksyon\naksyon aksyon\nautomation\nbalance\nbuksan\ncron\ncrypto\ndefi\nfinance\nhinula\nilista\ninvoice\nkahilingan\nkasangkapan\nkunin\nliquidity\nmonitor\npamahalaan\npamamahala\npamamahala aksyon\npera\nportfolio\nsign transaction\nswap\ntoken\ntransfer\ntrigger\nwallet\nworkflow",
          vi: "chuyen\nchuyển\ncong cu\ncông cụ\ncrypto\ndefi\nhanh dong\nhành động\nhành động hành động\nkich hoat\nký giao dịch\nlay\nlấy\nliet ke\nliệt kê\nmo\nmở\nquan ly\nquản lý\nquản lý hành động\nquy trinh\nquy trình\nso du\nsố dư\nsuy luan\nsuy luận\ntai chinh\ntài chính\nthanh khoản\ntien\ntiền\ntien ma hoa\ntiền mã hóa\ntoken\ntu dong hoa\ntự động hóa\nvi\nví\nyeu cau\nyêu cầu",
          "zh-CN":
            "交换\n代币\n令牌\n余额\n列出\n加密货币\n发票\n地址\n定时\n工作流\n工具\n打开\n投资组合\n推断\n操作\n操作 操作\n流动性\n监控\n签名交易\n管理\n管理 操作\n自动化\n获取\n触发器\n请求\n财务\n账户\n转账\n钱\n钱包\n链上",
        },
      },
    },
    listAdSlots: {
      request: {
        base: "ad revenue\nad_revenue\napps list ad slots\nasks\nasks their\nclicks\nclicks revenue\ncloud\nearnings\neliza\nfinance list ad slots\nimpressions\nimpressions clicks\ninventory\ninventory earnings\nlist\nlist ad slots\nlist user\nlist_ad_slots\nmy ad inventory\nmy_ad_inventory\nrevenue\nrevenue user\nsettings list ad slots\nshow ad slots\nshow_ad_slots\nslots\ntheir\ntheir inventory\nuser\nuser asks\nuser eliza\nuser slots",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion listar\napp\nclic\nconfiguracion\nconfiguracion listar\ncuenta\ndinero\nfactura\nfinanzas\nhacer clic\nherramienta\ninventario\nlistar\nlistar usuario\nmodelo\nmostrar\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n목록\n목록 사용자\n사용자\n사용자 질문\n설정\n설정 목록\n앱\n앱 목록\n요청\n작업\n잔액\n재고\n질문\n청구서\n클릭\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo listar\napp\nclicar\nconfiguracao\nconfiguracoes\nconfiguracoes listar\nconta\ndinheiro\nestoque\nfatura\nferramenta\nfinancas\ninventario\nlistar\nlistar usuario\nmodelo\nmostrar\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp ilista\nbalance\nclick\nconfiguration\nfinance\ngumagamit\nilista\nilista user\nimbentaryo\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings ilista\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê\ncấu hình\ncong cu\ncông cụ\nhang ton kho\nhàng tồn kho\nhanh dong\nhành động\nhoi\nhỏi\nliet ke\nliệt kê\nliệt kê người dùng\nnguoi dung\nngười dùng\nngười dùng hỏi\nnhap\nnhấp\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n列出\n列出 用户\n发票\n工具\n库存\n应用\n应用 列出\n开关\n投资组合\n操作\n模型设置\n点击\n用户\n用户 询问\n设置\n设置 列出\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    listAppDomains: {
      request: {
        base: "app\napp attached\napp domains\napp registrar\napp whether\napp_domains\napps list app domains\nasks\nasks what\nattached\ncloud\ncloud app\ncustom\ndate\ndate read\ndomain\ndomains\ndomains app\ndomains read\neliza\nfinance list app domains\nlist\nlist app domains\nlist cloud\nlist custom\nlist domains\nlist_app_domains\nlist_domains\nmy domains\nmy_domains\nonly\nonly user\nread\nread only\nregistrar\nregistrar status\nrenewal\nsettings list app domains\nshow domains\nshow_domains\nstate\nstatus\nstatus verification\nuser\nuser asks\nverification\nverified\nwhat\nwhat domains\nwhat_domains\nwhether",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion listar aplicacion\napp\nconfiguracion\nconfiguracion listar aplicacion\ncuenta\ndinero\nestado\nfactura\nfinanzas\nherramienta\nleer\nlistar\nlistar aplicacion\nmodelo\nmostrar\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n목록\n목록 앱\n사용자\n사용자 질문\n상태\n설정\n설정 목록 앱\n앱\n앱 목록 앱\n요청\n읽기\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo listar aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes listar aplicativo\nconta\ndinheiro\nestado\nfatura\nferramenta\nfinancas\nler\nlistar\nlistar aplicativo\nmodelo\nmostrar\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nstatus\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp ilista app\nbalance\nbasahin\nconfiguration\nfinance\ngumagamit\nilista\nilista app\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings ilista app\nstatus\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê ứng dụng\ncấu hình\ncong cu\ncông cụ\ndoc\nđọc\nhanh dong\nhành động\nhoi\nhỏi\nliet ke\nliệt kê\nliệt kê ứng dụng\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntrang thai\ntrạng thái\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n列出\n列出 应用\n发票\n工具\n应用\n应用 列出 应用\n开关\n投资组合\n操作\n模型设置\n状态\n用户\n用户 询问\n设置\n设置 列出 应用\n询问\n请求\n读取\n财务\n账户\n配置\n钱",
        },
      },
    },
    listCloudApps: {
      request: {
        base: "app\napps\napps list cloud apps\napps name\napps sites\napps user\nasks\ncloud\ncloud apps\ncloud_apps\ncreated\ncredits\ndeployed\ndeployment\ndeployment status\ndevice\nearnings\neliza\nexplicitly\nfinance list cloud apps\ngeneral list cloud apps\ngeneric\nget apps\nget_apps\nhave\nhosted\nhosted apps\ninstalled\ninstalled apps\ninventory\nlist\nlist cloud apps\nlist eliza\nlist eliza cloud apps\nlist user\nlist_cloud_apps\nlist_eliza_cloud_apps\nlocal\nlocally\nmade\nmy apps\nmy cloud apps\nmy deployed apps\nmy hosted apps\nmy sites\nmy_apps\nmy_cloud_apps\nmy_deployed_apps\nmy_hosted_apps\nmy_sites\nname\nname status\nowns\npresent\nrunning\nsettings list cloud apps\nsites\nstatus\nstatus credits\nstatus locally\ntheir\nthey\nuser\nuser eliza\nuser owns\nwhat\nwhat apps do i have\nwhat_apps_do_i_have",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion listar aplicacion\naplicacion usuario\napp\nchat general\nconfiguracion\nconfiguracion listar aplicacion\nconversacion\ncuenta\ndinero\nestado\nfactura\nfinanzas\ngeneral\ngeneral listar aplicacion\nhablar\nherramienta\ninventario\nlistar\nlistar aplicacion\nlistar usuario\nmodelo\nmostrar\nobtener\nobtener aplicacion\nportafolio\npreferencias\npreguntar\nrespuesta\nsaldo\nsolicitud\nusuario",
          ko: "가져오기\n가져오기 앱\n계정\n구성\n금융\n답변\n도구\n돈\n말하기\n모델 설정\n목록\n목록 사용자\n목록 앱\n사용자\n상태\n설정\n설정 목록 앱\n앱\n앱 목록 앱\n앱 사용자\n요청\n일반\n일반 대화\n일반 목록 앱\n작업\n잔액\n재고\n질문\n채팅\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo listar aplicativo\naplicativo usuario\napp\nchat geral\nconfiguracao\nconfiguracoes\nconfiguracoes listar aplicativo\nconta\nconversa\ndinheiro\nestado\nestoque\nfalar\nfatura\nferramenta\nfinancas\ngeral\ngeral listar aplicativo\ninventario\nlistar\nlistar aplicativo\nlistar usuario\nmodelo\nmostrar\nobter\nobter aplicativo\nperguntar\nportfolio\npreferencias\nresposta\nsaldo\nsolicitacao\nstatus\nusuario",
          tl: "account\naksyon\napp\napp ilista app\napp user\nbalance\nconfiguration\nfinance\ngeneral chat\ngumagamit\nilista\nilista app\nilista user\nimbentaryo\ninvoice\nkahilingan\nkasangkapan\nkunin\nkunin app\nmagtanong\nmakipag-usap\nmodel settings\npangkalahatan\npangkalahatan ilista app\npera\nportfolio\npreferences\nsagot\nsettings\nsettings ilista app\nstatus\ntoggle\nusap\nuser",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê ứng dụng\ncấu hình\nchung\nchung liệt kê ứng dụng\ncong cu\ncông cụ\nhang ton kho\nhàng tồn kho\nhanh dong\nhành động\nhoi\nhỏi\nlay\nlấy\nlấy ứng dụng\nliet ke\nliệt kê\nliệt kê người dùng\nliệt kê ứng dụng\nnguoi dung\nngười dùng\nnói chuyện\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntra loi\ntrả lời\ntrang thai\ntrạng thái\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê ứng dụng\nứng dụng người dùng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n列出\n列出 应用\n列出 用户\n发票\n回复\n回答\n对话\n工具\n库存\n应用\n应用 列出 应用\n应用 用户\n开关\n投资组合\n操作\n普通聊天\n模型设置\n状态\n用户\n获取\n获取 应用\n设置\n设置 列出 应用\n询问\n请求\n财务\n账户\n通用\n通用 列出 应用\n配置\n钱",
        },
      },
    },
    listFrontendDeployments: {
      request: {
        base: "app\napp frontend\napp frontend deployments\napp_frontend_deployments\napps list frontend deployments\nasks\nasks their\ncloud\ncloud app\ndeploy\ndeploy history\ndeployment\neliza\nfrontend\nfrontend history\nfrontend_history\nhistory\nlist\nlist app\nlist eliza\nlist frontend deployments\nlist_frontend_deployments\nlive\nlive user\nsettings list frontend deployments\nshow frontend versions\nshow_frontend_versions\ntheir\ntheir app\nuser\nuser asks\nversions\nwhich",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion listar\napp\nconfiguracion\nconfiguracion listar\nherramienta\nhistorial\nlistar\nlistar aplicacion\nmodelo\nmostrar\npreferencias\npreguntar\nsolicitud\nusuario\nusuario preguntar",
          ko: "구성\n기록\n도구\n모델 설정\n목록\n목록 앱\n사용자\n사용자 질문\n설정\n설정 목록\n앱\n앱 목록\n요청\n작업\n질문\n토글\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo listar\napp\nconfiguracao\nconfiguracoes\nconfiguracoes listar\nferramenta\nhistorico\nlistar\nlistar aplicativo\nmodelo\nmostrar\nperguntar\npreferencias\nsolicitacao\nusuario\nusuario perguntar",
          tl: "aksyon\napp\napp ilista\nconfiguration\ngumagamit\nhistory\nilista\nilista app\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npreferences\nsettings\nsettings ilista\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nlich su\nlịch sử\nliet ke\nliệt kê\nliệt kê ứng dụng\nnguoi dung\nngười dùng\nngười dùng hỏi\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n列出\n列出 应用\n历史\n工具\n应用\n应用 列出\n开关\n操作\n模型设置\n用户\n用户 询问\n设置\n设置 列出\n询问\n请求\n配置",
        },
      },
    },
    listInfluencers: {
      request: {
        base: "active\nactive influencer\napps list influencers\nbook\nbook promotion\nbrowse\nbrowse active\nbrowse influencers\nbrowse_influencers\ncloud\neliza\nfinance list influencers\nfind\nfind hire\nfind influencers\nfind_influencers\nhire\ninfluencer\ninfluencer profiles\nlist influencers\nlist_influencers\nniche\nniche user\noptionally\npick\npick book\nprofiles\nprofiles book\nprofiles eliza\npromotion\npromotion user\nsearch influencers\nsearch_influencers\nsettings list influencers\nuser\nuser pick\nuser wants\nwants\nwants find",
        locales: {
          es: "accion\nactivar\nactivo\najustes\naplicacion\naplicacion listar\napp\nbuscar\nconfiguracion\nconfiguracion listar\ncuenta\ndinero\nencontrar\nfactura\nfinanzas\nherramienta\nlistar\nmodelo\nmostrar\nperfil\nperfil reservar\nportafolio\npreferencias\nreservar\nsaldo\nsolicitud\nusuario",
          ko: "검색\n계정\n구성\n금융\n도구\n돈\n모델 설정\n목록\n사용자\n설정\n설정 목록\n앱\n앱 목록\n예약\n요청\n작업\n잔액\n찾기\n청구서\n토글\n포트폴리오\n프로필\n프로필 예약\n환경설정\n활성",
          pt: "acao\nalternar\naplicativo\naplicativo listar\napp\nativo\nbuscar\nconfiguracao\nconfiguracoes\nconfiguracoes listar\nconta\ndinheiro\nencontrar\nfatura\nferramenta\nfinancas\nlistar\nmodelo\nmostrar\nperfil\nperfil reservar\nportfolio\npreferencias\nreservar\nsaldo\nsolicitacao\nusuario",
          tl: "account\naksyon\naktibo\napp\napp ilista\nbalance\nconfiguration\nfinance\ngumagamit\nhanapin\nilista\ninvoice\nireserba\nkahilingan\nkasangkapan\nmag-book\nmaghanap\nmodel settings\npera\nportfolio\npreferences\nprofile\nprofile mag-book\nsettings\nsettings ilista\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt liệt kê\ncấu hình\ncong cu\ncông cụ\ndang hoat dong\nđang hoạt động\ndat\nđặt\nhanh dong\nhành động\nho so\nhồ sơ\nhồ sơ đặt\nliet ke\nliệt kê\nnguoi dung\nngười dùng\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntim\ntìm\ntim kiem\ntìm kiếm\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n列出\n发票\n工具\n应用\n应用 列出\n开关\n投资组合\n搜索\n操作\n查找\n模型设置\n活跃\n用户\n设置\n设置 列出\n请求\n财务\n账户\n资料\n资料 预订\n配置\n钱\n预订",
        },
      },
    },
    listOverdueFollowups: {
      request: {
        base: "calendar list overdue followups\ncontacts list overdue followups\nfollowup list\nfollowup list overdue\nfollowup_list\nfollowup_list_overdue\nlist followups\nlist overdue followups\nlist_followups\nlist_overdue_followups\nmessaging list overdue followups\noverdue followups\noverdue_followups\ntasks list overdue followups\nwho haven t i talked to\nwho to follow up\nwho_haven_t_i_talked_to\nwho_to_follow_up",
        locales: {
          es: "accion\namigo\ncalendario\ncalendario listar\ncolega\ncontacto\ncontacto listar\ncontactos\nfecha limite\ngente\nherramienta\nlistar\nmostrar\npendiente\npersona\nrecordatorio\nrelacion\nseguimiento\nseguir\nsolicitud\ntarea\ntarea listar\ntareas",
          ko: "관계\n도구\n동료\n리마인더\n마감일\n목록\n사람\n연락처\n연락처 목록\n요청\n일정\n작업\n작업 목록\n친구\n캘린더\n캘린더 목록\n팔로우\n할 일\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\namigo\ncalendario\ncalendario listar\ncolega\ncontato\ncontato listar\ncontatos\nferramenta\nlembrete\nlistar\nmostrar\npessoa\npessoas\nprazo\nrelacao\nseguir\nsolicitacao\ntarefa\ntarefa listar\ntarefas",
          tl: "aksyon\ncontact\ncontact ilista\ncontacts\ndeadline\nfollow up\ngawain\ngawain ilista\nilista\nkahilingan\nkaibigan\nkalendaryo\nkalendaryo ilista\nkasamahan\nkasangkapan\npaalala\nrelasyon\nsundan\ntao\ntask\ntodo",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nlich\nlịch\nlịch liệt kê\nlien he\nliên hệ\nliên hệ liệt kê\nliet ke\nliệt kê\nnguoi\nngười\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnhiệm vụ liệt kê\nquan he\nquan hệ\ntac vu\ntác vụ\ntheo doi\ntheo dõi\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "人物\n任务\n任务 列出\n关注\n关系\n列出\n同事\n工具\n待办\n截止日期\n提醒\n操作\n日历\n日历 列出\n朋友\n联系人\n联系人 列出\n请求\n跟进",
        },
      },
    },
    listPressReleases: {
      request: {
        base: "apps list press releases\nbefore\nchoosing\nchoosing draft\ncloud\ndraft\ndraft submit\ndrafts\ndrafts submissions\nedit\neliza\nlist\nlist pr drafts\nlist press\nlist press releases\nlist user\nlist_pr_drafts\nlist_press_releases\nmy press releases\nmy_press_releases\npress\nrelease\nrelease drafts\nreleases\nsettings list press releases\nshow press releases\nshow_press_releases\nstatuses\nsubmissions\nsubmit\nsubmit edit\nuser\nuser eliza",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion listar\napp\nborrador\nconfiguracion\nconfiguracion listar\neditar\nherramienta\nlistar\nlistar pr borrador\nlistar usuario\nmodelo\nmostrar\npreferencias\nsolicitud\nusuario",
          ko: "구성\n도구\n모델 설정\n목록\n목록 pr 초안\n목록 사용자\n사용자\n설정\n설정 목록\n앱\n앱 목록\n요청\n작업\n초안\n토글\n편집\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo listar\napp\nconfiguracao\nconfiguracoes\nconfiguracoes listar\neditar\nferramenta\nlistar\nlistar pr rascunho\nlistar usuario\nmodelo\nmostrar\npreferencias\nrascunho\nsolicitacao\nusuario",
          tl: "aksyon\napp\napp ilista\nconfiguration\ndraft\ngumagamit\ni-edit\nilista\nilista pr draft\nilista user\nkahilingan\nkasangkapan\nmodel settings\npreferences\nsettings\nsettings ilista\ntoggle\nuser",
          vi: "ban nhap\nbản nháp\ncai dat\ncài đặt\ncài đặt liệt kê\ncấu hình\nchinh sua\nchỉnh sửa\ncong cu\ncông cụ\nhanh dong\nhành động\nliet ke\nliệt kê\nliệt kê người dùng\nliệt kê pr bản nháp\nnguoi dung\nngười dùng\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng liệt kê\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n列出\n列出 pr 草稿\n列出 用户\n工具\n应用\n应用 列出\n开关\n操作\n模型设置\n用户\n编辑\n草稿\n设置\n设置 列出\n请求\n配置",
        },
      },
    },
    localInference: {
      request: {
        base: "action\naction twin\nactivates\nactivates clears\nactive\nactive local\nassignment\ncancels\nclears\nclears active\ndownloads\ndownloads activates\ninference\ninstalled\nlocal\nlocal inference\nlocal inference settings\nlocal model\nlocal models\nlocal_inference\nlocal_inference_settings\nlocal_model\nlocal_models\nmodel\nmodel downloads\nmodel hub\nmodel updates\nmodel_hub\nmutations\nonly\nonly action\nowner\npreferences\nrouting\nslots\nstarts\ntwin\nuninstalls\nupdates\nupdates local\nverifies\nview\nvoice\nvoice model settings\nvoice_model_settings",
        locales: {
          es: "accion\nactivo\nactualizar\nborrar\nconfiguracion\ndescargar\nherramienta\nlimpiar\nlimpiar activo\nsolicitud",
          ko: "다운로드\n도구\n설정\n업데이트\n요청\n작업\n지우기\n지우기 활성\n활성",
          pt: "acao\nativo\natualizar\nbaixar\nconfiguracoes\nferramenta\nlimpar\nlimpar ativo\nsolicitacao",
          tl: "aksyon\naktibo\ni-download\ni-update\nkahilingan\nkasangkapan\nlinisin\nlinisin aktibo\nsettings",
          vi: "cai dat\ncài đặt\ncap nhat\ncập nhật\ncong cu\ncông cụ\ndang hoat dong\nđang hoạt động\nhanh dong\nhành động\ntai xuong\ntải xuống\nxoa\nxóa\nxóa đang hoạt động\nyeu cau\nyêu cầu",
          "zh-CN": "下载\n工具\n操作\n更新\n活跃\n清除\n清除 活跃\n设置\n请求",
        },
      },
    },
    logs: {
      request: {
        base: "action\naction delete\naction level\naction search\nadmin logs\nagent\nagent internal logs\nagent logs\nagent_internal logs\nbuffer\nbuffer action\nchange log level\nchange_log_level\nclear logs\nclear_logs\nclears\nclears that\nconfigure logging\nconfigure_logging\ncontrol\ncontrol action\ncontrol search\ndebug\ndebug mode\ndebug_mode\ndelete\ndelete agent\ndelete clears\ndelete logs\ndelete_logs\nempty logs\nempty_logs\nerror\nfilterable\nget logs\nget_logs\ninfo\ninspect logs\ninspect_logs\nlevel\nlevel room\nlog level\nlog_level\nlogs\nlogs level\nlookup logs\nlookup_logs\nmemory\nmemory buffer\nonly\noverrides\noverrides room\nowner\npolymorphic\npolymorphic control\nquery logs\nquery_logs\nread logs\nread_logs\nreset logs\nreset_logs\nroom\nroom level\nroom owner\nsearch\nsearch delete\nsearch logs\nsearch tails\nsearch_logs\nset debug\nset log level\nset_debug\nset_log_level\nsettings logs\nsince\nsince action\nsince delete\nsource\ntails\ntails memory\nthat\ntrace\nview logs\nview_logs\nwarn\nwipe logs\nwipe_logs",
        locales: {
          es: "accion\naccion buscar\naccion eliminar\nactivar\nadministrador\nadministrador registros\nagente\nagente registros\najustes\nborrar\nbuscar\nbuscar eliminar\nbuscar registros\nchat\nconfiguracion\nconfigurar\nconsulta\nconsulta registros\ncontrolar\ncontrolar accion\ncontrolar buscar\ndueño\neliminar\neliminar agente\neliminar limpiar\neliminar registros\nestado interno\ngestion interna\nherramienta\ninterno del agente\nleer\nleer registros\nlimpiar\nlimpiar registros\nlogs\nmemoria\nmodelo\nobtener\nobtener registros\npermisos\npolitica\npreferencias\nregistros\nroles\nsala\nsolicitud",
          ko: "가져오기\n가져오기 로그\n검색\n검색 로그\n검색 삭제\n관리자\n관리자 로그\n구성\n권한\n기억\n내부 상태\n도구\n로그\n모델 설정\n방\n삭제\n삭제 로그\n삭제 에이전트\n삭제 지우기\n설정\n소유자\n에이전트\n에이전트 내부\n에이전트 로그\n역할\n요청\n읽기\n읽기 로그\n자체 관리\n작업\n작업 검색\n작업 삭제\n정책\n제어\n제어 검색\n제어 작업\n지우기\n지우기 로그\n질의\n채팅방\n쿼리\n쿼리 로그\n토글\n환경설정",
          pt: "acao\nacao buscar\nacao excluir\nadministrador\nadministrador logs\nagente\nagente logs\nalternar\napagar\nbuscar\nbuscar excluir\nbuscar logs\nchat\nconfiguracao\nconfiguracoes\nconfigurar\nconsulta\nconsulta logs\ncontrolar\ncontrolar acao\ncontrolar buscar\ndono\nestado interno\nexcluir\nexcluir agente\nexcluir limpar\nexcluir logs\nferramenta\nfuncoes\ngestao interna\ninterno do agente\nler\nler logs\nlimpar\nlimpar logs\nlogs\nmemoria\nmodelo\nobter\nobter logs\npermissoes\npolitica\npreferencias\nregistros\nsala\nsolicitacao",
          tl: "admin\nadmin logs\nagent\nagent logs\naksyon\naksyon burahin\naksyon maghanap\nalaala\nbasahin\nbasahin logs\nburahin\nburahin agent\nburahin linisin\nburahin logs\nconfiguration\ni-configure\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nkontrol\nkontrol aksyon\nkontrol maghanap\nkunin\nkunin logs\nkuwarto\nlinisin\nlinisin logs\nlogs\nmaghanap\nmaghanap burahin\nmaghanap logs\nmay ari\nmemory\nmodel settings\npahintulot\npatakaran\npreferences\nquery\nquery logs\nrole\nroom\nsariling pamamahala\nsettings\ntoggle",
          vi: "cai dat\ncài đặt\ncau hinh\ncấu hình\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ndieu khien\nđiều khiển\nđiều khiển hành động\nđiều khiển tìm kiếm\nđọc nhật ký\nhanh dong\nhành động\nhành động tìm kiếm\nhành động xóa\nky uc\nký ức\nlấy nhật ký\nnhat ky\nnhật ký\nnoi bo tac tu\nnội bộ tác tử\nquan tri\nquản trị\nquản trị nhật ký\nquyen\nquyền\ntac tu\ntác tử\ntác tử nhật ký\ntim kiem\ntìm kiếm\ntìm kiếm nhật ký\ntìm kiếm xóa\ntruy van\ntruy vấn\ntruy vấn nhật ký\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn\nxóa nhật ký\nxóa tác tử\nxóa xóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 日志\n代理内部\n偏好\n内部状态\n删除\n删除 代理\n删除 日志\n删除 清除\n工具\n开关\n房间\n所有者\n控制\n控制 搜索\n控制 操作\n搜索\n搜索 删除\n搜索 日志\n操作\n操作 删除\n操作 搜索\n日志\n智能体\n权限\n查询\n查询 日志\n模型设置\n清除\n清除 日志\n策略\n管理员\n管理员 日志\n聊天室\n自我管理\n获取\n获取 日志\n角色\n记忆\n设置\n请求\n读取\n读取 日志\n配置",
        },
      },
    },
    managePlugins: {
      request: {
        base: "action\nadmin manage plugins\nclones\nconnectors manage plugins\ncontrol\ncopy\ncore\ndetails\ndisable\neject\nejected\nenable\ninstall\ninstalled\ninstalls\nlist\nload\nloaded\nlocal\nlocally\nmanage ejected plugins\nmanage installed plugins\nmanage plugins\nmanage_ejected_plugins\nmanage_installed_plugins\nmanage_plugins\nplugin\nplugin control\nplugin manager\nplugin_control\nplugin_manager\nplugins\npulls\nqueries\nregistered\nregistry\nreinject\nremoves\nreports\nruntime\nsearch\nsettings manage plugins\nshows\nstate\nstatus\nsubaction\nsync\nunified\nunload\nupstream",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrador gestionar plugin\nadministrar\najustes\nbuscar\ncomplemento\nconector\nconector gestionar plugin\nconfiguracion\nconfiguracion gestionar plugin\nconsulta\ncontrolar\ncuenta conectada\ndesactivar\ndetalles\ndueño\neliminar\nestado\ngestionar\ngestionar plugin\nherramienta\ninstalar\nintegracion\nlistar\nmcp\nmodelo\nmostrar\noauth\npermisos\nplugin\nplugin controlar\npolitica\npreferencias\nquitar\nroles\nsolicitud",
          ko: "검색\n계정 연결\n관리\n관리 플러그인\n관리자\n관리자 관리 플러그인\n구성\n권한\n도구\n모델 설정\n목록\n비활성화\n상태\n설정\n설정 관리 플러그인\n설치\n세부정보\n소유자\n역할\n오어스\n요청\n작업\n정책\n제거\n제어\n질의\n커넥터\n커넥터 관리 플러그인\n쿼리\n토글\n통합\n플러그인\n플러그인 제어\n환경설정\n활성화",
          pt: "acao\nadministrador\nadministrador gerenciar plugin\nalternar\nativar\nbuscar\nconector\nconector gerenciar plugin\nconfiguracao\nconfiguracoes\nconfiguracoes gerenciar plugin\nconsulta\nconta conectada\ncontrolar\ndesativar\ndetalhes\ndono\nestado\nferramenta\nfuncoes\ngerenciar\ngerenciar plugin\ninstalar\nintegracao\nlistar\nmcp\nmodelo\nmostrar\noauth\npermissoes\nplugin\nplugin controlar\npolitica\npreferencias\nremover\nsolicitacao\nstatus",
          tl: "account connection\nadmin\nadmin pamahalaan plugin\naksyon\nalisin\nconfiguration\nconnector\nconnector pamahalaan plugin\ndetalye\ni-disable\ni-enable\ni-install\nilista\nintegration\nkahilingan\nkasangkapan\nkontrol\nmaghanap\nmay ari\nmodel settings\noauth\npahintulot\npamahalaan\npamahalaan plugin\npatakaran\nplugin\nplugin kontrol\npreferences\nquery\nrole\nsettings\nsettings pamahalaan plugin\nstatus\ntoggle",
          vi: "bat\nbật\ncai dat\ncài đặt\ncài đặt quản lý plugin\ncấu hình\nchi tiet\nchi tiết\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ndieu khien\nđiều khiển\ngỡ\nhanh dong\nhành động\nket noi\nkết nối\nkết nối quản lý plugin\nliet ke\nliệt kê\noauth\nplugin\nplugin điều khiển\nquan ly\nquản lý\nquản lý plugin\nquan tri\nquản trị\nquản trị quản lý plugin\nquyen\nquyền\ntài khoản\ntat\ntắt\ntich hop\ntích hợp\ntim kiem\ntìm kiếm\ntrang thai\ntrạng thái\ntruy van\ntruy vấn\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n列出\n启用\n安装\n工具\n开关\n所有者\n授权\n控制\n插件\n插件 控制\n搜索\n操作\n权限\n查询\n模型设置\n状态\n禁用\n移除\n策略\n管理\n管理 插件\n管理员\n管理员 管理 插件\n角色\n设置\n设置 管理 插件\n详情\n请求\n账号连接\n连接器\n连接器 管理 插件\n配置\n集成",
        },
      },
    },
    manageTranscriptPrivacy: {
      request: {
        base: "artifact\naudio\naudio while\nchange\ndelete\ndelete source\ndelete transcript source audio\ndelete_transcript_source_audio\nmanage meeting retention\nmanage transcript privacy\nmanage_meeting_retention\nmanage_transcript_privacy\nmeeting\npermanently\npermanently delete\npreserving\nretained\nset transcript artifact visibility\nset_transcript_artifact_visibility\nsource\nsource audio\ntranscript\nvisibility\nwhile",
        locales: {
          es: "accion\nadministrar\naudio\nborrar\neliminar\neliminar audio\ngestionar\nherramienta\nsolicitud",
          ko: "관리\n도구\n삭제\n삭제 오디오\n오디오\n요청\n작업",
          pt: "acao\napagar\naudio\nexcluir\nexcluir audio\nferramenta\ngerenciar\nsolicitacao",
          tl: "aksyon\naudio\nburahin\nburahin audio\nkahilingan\nkasangkapan\npamahalaan",
          vi: "am thanh\nâm thanh\ncong cu\ncông cụ\nhanh dong\nhành động\nquan ly\nquản lý\nxoa\nxóa\nxóa âm thanh\nyeu cau\nyêu cầu",
          "zh-CN": "删除\n删除 音频\n工具\n操作\n管理\n请求\n音频",
        },
      },
    },
    maps: {
      request: {
        base: "action\naction requested\ncreate\ncreate shareable\ndestination\ndirections\nhand\nknown\nlinks\nlocation maps\nlook\nmap\nmaps\nmaps action\nnavigation\noperation\noperation known\nplace\nplace search\nplaces\nplaces create\nplaces plan\nplan\nplan routes\nproductivity maps\npromoted\nrequested\nrequested operation\nroute\nroutes\nsave\nsaved\nsaved places\nsaved_places\nsearch\nsearch routes\nshareable\nsharing\nspecific\ntravel maps",
        locales: {
          es: "accion\nbuscar\ncrear\nherramienta\noperacion\nplan\nplan de trabajo\nplanificacion\nprioridades\nproductividad\nsolicitud\nviaje",
          ko: "검색\n계획\n도구\n생산성\n생성\n업무 계획\n여행\n요청\n우선순위\n작업",
          pt: "acao\nbuscar\ncriar\nferramenta\noperacao\nplanejamento\nplano\nplano de trabalho\nprioridades\nprodutividade\nsolicitacao\nviagem",
          tl: "aksyon\nbiyahe\ngumawa\nkahilingan\nkasangkapan\nmaghanap\noperasyon\npagpaplano\nplano\nprayoridad\nproductivity\nwork plan",
          vi: "cong cu\ncông cụ\ndu lich\ndu lịch\nhanh dong\nhành động\nke hoach\nkế hoạch\nlap ke hoach\nlập kế hoạch\nnang suat\nnăng suất\ntao\ntạo\nthao tac\nthao tác\ntim kiem\ntìm kiếm\nưu tiên\nyeu cau\nyêu cầu",
          "zh-CN":
            "优先级\n创建\n工作计划\n工具\n搜索\n操作\n效率\n旅行\n规划\n计划\n请求",
        },
      },
    },
    markFollowupDone: {
      request: {
        base: "calendar mark followup done\ncontacted\ncontacts mark followup done\nfollowed up\nfollowed_up\nfollowup done\nfollowup_done\nmark contacted\nmark followup done\nmark_contacted\nmark_followup_done\nmessaging mark followup done\nrecord interaction\nrecord_interaction\ntasks mark followup done",
        locales: {
          es: "accion\namigo\ncalendario\ncolega\ncontacto\ncontactos\nfecha limite\ngente\nherramienta\npendiente\npersona\nrecordatorio\nrelacion\nseguimiento\nsolicitud\ntarea\ntareas",
          ko: "관계\n도구\n동료\n리마인더\n마감일\n사람\n연락처\n요청\n일정\n작업\n친구\n캘린더\n할 일\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\namigo\ncalendario\ncolega\ncontato\ncontatos\nferramenta\nlembrete\npessoa\npessoas\nprazo\nrelacao\nsolicitacao\ntarefa\ntarefas",
          tl: "aksyon\ncontact\ncontacts\ndeadline\nfollow up\ngawain\nkahilingan\nkaibigan\nkalendaryo\nkasamahan\nkasangkapan\npaalala\nrelasyon\ntao\ntask\ntodo",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nlich\nlịch\nlien he\nliên hệ\nnguoi\nngười\nnhắc nhở\nnhiem vu\nnhiệm vụ\nquan he\nquan hệ\ntac vu\ntác vụ\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "人物\n任务\n关系\n同事\n工具\n待办\n截止日期\n提醒\n操作\n日历\n朋友\n联系人\n请求\n跟进",
        },
      },
    },
    mcp: {
      request: {
        base: "accept\naccept search\naccess mcp resource\naccess resource\naccess_mcp_resource\naccess_resource\nactions\nactions connected\nactions discovers\nactions list\nalso\nautomation mcp\ncall\ncall mcp tool\ncall tool\ncall_mcp_tool\ncloud\nconnected\nconnected services\nconnected_services\nconnections\nconnections lists\nconnectors mcp\ndiscover actions\ndiscover tools\ndiscover_actions\ndiscover_tools\ndiscovers\ndiscovers tool\nentry\nexecute mcp tool\nexecute tool\nfetch mcp resource\nfetch resource\nfetch_mcp_resource\nfetch_resource\nfiles mcp\nfind actions\nfind tools\nfind_actions\nfind_tools\ngeneral mcp\nget connections\nget mcp resource\nget resource\nget_connections\nget_mcp_resource\nget_resource\ninvoke\ninvoke mcp tool\ninvoke tool\nknowledge mcp\nlist\nlist connections\nlist_connections\nlists\nlists oauth\nlookup actions\nlookup_actions\nmcp\nmcp action\nmcp router\nmcp_action\nmy connections\noauth\noauth connections\nplatforms\nplatforms list\npoint\npoint call\npoint read\nread\nread mcp resource\nread resource\nreads\nreads resource\nresource\nresource cloud\nresource read\nresource reads\nresource search\nrun mcp tool\nrun tool\nruntimes\nsearch\nsearch actions\nsearch tools\nshow connections\nsingle\ntool\ntool actions\ntool invoke\ntool read\nuse mcp\nuse mcp tool\nuse tool",
        locales: {
          es: "accion accion\naccion buscar\naccion leer\naccion listar\naccion llamar\narchivo\narchivo mcp\nautomatizacion\nautomatizacion mcp\nbuscar accion\nbuscar herramienta\nchat general\nconector\nconector mcp\nconocimiento\nconocimiento mcp\nconversacion\ncron\ncuenta conectada\ndisparador\nejecutar herramienta\nejecutar mcp herramienta\nflujo de trabajo\ngeneral mcp\nhablar\nhechos guardados\nherramienta accion\nherramienta leer\nintegracion\nleer archivo\nleer mcp recurso\nleer recurso\nlistar oauth\nllamar herramienta\nllamar mcp herramienta\nmcp\nmcp accion\nmcp herramienta\nmcp recurso\nmonitor\nnotas guardadas\noauth\nobtener mcp recurso\nobtener recurso\nrecordar\nrecurso buscar\nrecurso leer\nrespuesta",
          ko: "mcp 도구\nmcp 리소스\nmcp 작업\n가져오기 mcp 리소스\n가져오기 리소스\n검색\n검색 도구\n검색 작업\n계정 연결\n답변\n도구 읽기\n도구 작업\n리소스 검색\n리소스 읽기\n말하기\n모니터\n목록 oauth\n실행 mcp 도구\n실행 도구\n워크플로\n일반 mcp\n일반 대화\n읽기 mcp 리소스\n읽기 리소스\n자동화\n자동화 mcp\n작업 검색\n작업 목록\n작업 읽기\n작업 작업\n작업 통화\n저장된 노트\n저장된 사실\n지식\n지식 mcp\n찾기 도구\n찾기 작업\n채팅\n커넥터\n커넥터 mcp\n크론\n통화 mcp 도구\n통화 도구\n트리거\n파일 mcp\n파일 쓰기\n파일 읽기\n회상",
          pt: "acao acao\nacao buscar\nacao ler\nacao ligar\nacao listar\narquivo mcp\nautomacao\nautomacao mcp\nbuscar acao\nbuscar ferramenta\nchat geral\nconector\nconector mcp\nconhecimento\nconhecimento mcp\nconta conectada\nconversa\ncron\nencontrar acao\nencontrar ferramenta\nexecutar ferramenta\nexecutar mcp ferramenta\nfalar\nfatos salvos\nferramenta acao\nferramenta ler\nfluxo de trabalho\ngatilho\ngeral mcp\nintegracao\nlembrar\nler arquivo\nler mcp recurso\nler recurso\nligar ferramenta\nligar mcp ferramenta\nlistar oauth\nmcp acao\nmcp ferramenta\nmcp recurso\nmonitor\nnotas salvas\noauth\nobter mcp recurso\nobter recurso\nrecurso buscar\nrecurso ler\nresposta",
          tl: "account connection\naksyon aksyon\naksyon basahin\naksyon ilista\naksyon maghanap\naksyon tawag\nalalahanin\nautomation\nautomation mcp\nbasahin file\nbasahin mcp resource\nbasahin resource\nconnector\nconnector mcp\ncron\nfile mcp\ngeneral chat\nhanapin aksyon\nhanapin tool\nilista oauth\nintegration\nkaalaman\nkaalaman mcp\nkunin mcp resource\nkunin resource\nmaghanap aksyon\nmaghanap tool\nmakipag-usap\nmcp aksyon\nmcp resource\nmcp tool\nmonitor\noauth\npangkalahatan mcp\npatakbuhin mcp tool\npatakbuhin tool\nresource basahin\nresource maghanap\nsagot\nsaved facts\nsaved notes\ntawag mcp tool\ntawag tool\ntool aksyon\ntool basahin\ntrigger\nusap\nworkflow",
          vi: "cong cu\ncông cụ\nđọc mcp tài nguyên\nđọc tài nguyên\ndoc tep\nđọc tệp\nghi chu da luu\nghi chú đã lưu\ngọi công cụ\ngọi mcp công cụ\nhanh dong\nhành động\nket noi\nkết nối\nkich hoat\nkien thuc\nkiến thức\nlấy mcp tài nguyên\nlấy tài nguyên\nliet ke\nliệt kê\nmcp hành động\nmcp tài nguyên\nnhớ lại\nnói chuyện\nquy trinh\nquy trình\ntài khoản\ntai nguyen\ntài nguyên\nthu muc\nthư mục\ntich hop\ntích hợp\ntìm công cụ\ntìm hành động\ntim kiem\ntìm kiếm\ntìm kiếm công cụ\ntìm kiếm hành động\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\nuy quyen\nủy quyền",
          "zh-CN":
            "mcp 工具\nmcp 操作\nmcp 资源\n列出 oauth\n回复\n回忆\n回答\n定时\n对话\n工作流\n工具 操作\n工具 读取\n已保存事实\n已保存笔记\n执行 mcp 工具\n执行 工具\n授权\n搜索 工具\n搜索 操作\n操作 列出\n操作 搜索\n操作 操作\n操作 读取\n操作 通话\n文件 mcp\n普通聊天\n查找 工具\n查找 操作\n监控\n知识\n知识 mcp\n自动化\n自动化 mcp\n获取 mcp 资源\n获取 资源\n触发器\n语义搜索\n读取 mcp 资源\n读取 资源\n资源 搜索\n资源 读取\n运行 mcp 工具\n连接器\n连接器 mcp\n通用 mcp\n通话 mcp 工具\n通话 工具\n集成",
        },
      },
    },
    memory: {
      request: {
        base: "agent\nagent internal memory\nagent memory\nagent_internal memory\nbrowse memories\nbrowse_memories\nconfirm\ncreate\ncreate memory\ncreate search\ncreate stores\ncreate_memory\ndelete\ndelete delete\ndelete memory\ndelete removes\ndelete require\ndelete update\ndelete_memory\ndocuments memory\nedit memory\nedit_memory\nedits\nedits text\nembeds\nentity\nentity room\nfilter memories\nfilter_memories\nfilters\nfind memories\nfind_memories\nforget memory\nforget_memory\nlist memories\nlist_memories\nmanage\nmanage agent\nmatch\nmemorize\nmemory\nmemory create\nmemory memory\nmemory query\nmemory recall\nmemory records\nmemory requires\nmemory search\nmemory_recall\nmemory_search\nmodify memory\nmodify_memory\nquery\nquery update\nrecall memories\nrecall memory\nrecall memory filtered\nrecall_memories\nrecall_memory\nrecall_memory_filtered\nrecords\nrecords create\nremember this\nremember_this\nremove memory\nremove_memory\nremoves\nremoves memory\nrequire\nrequires\nroom\nroom query\nsave memory\nsave_memory\nsearch\nsearch filters\nsearch memories\nsearch memory\nsearch update\nsearch_memories\nsearch_memory\nstore memory\nstore_memory\nstores\nstores memory\ntext\ntrue\ntrue delete\ntype\nupdate\nupdate delete\nupdate edits\nupdate memory\nupdate_memory\nwrite memory\nwrite_memory",
        locales: {
          es: "actualizar\nactualizar editar\nactualizar eliminar\nactualizar memoria\nagente memoria\narchivo\nborrar\nbuscar\nbuscar actualizar\nbuscar memoria\nconsulta actualizar\ncrear\ncrear buscar\ncrear memoria\ncrear tienda\ndocumento\ndocumento memoria\ndocumentos\neditar\neditar memoria\neliminar\neliminar actualizar\neliminar eliminar\neliminar memoria\nencontrar\nescribir\nescribir memoria\nestado interno\ngestion interna\ngestionar agente\nguardar memoria\nguardar notas\ninterno del agente\nlistar\nlistar memoria\nmemoria\nmemoria buscar\nmemoria consulta\nmemoria crear\nmemoria memoria\nmostrar\nnotas\nquitar\nrecordar\nrecuerdo\nsala consulta\ntienda\ntienda memoria",
          ko: "검색\n검색 기억\n검색 업데이트\n관리 에이전트\n기억\n기억 검색\n기억 기억\n기억 생성\n기억 쿼리\n기억해\n내부 상태\n노트\n목록\n목록 기억\n문서\n문서 기억\n방 쿼리\n삭제\n삭제 기억\n삭제 삭제\n삭제 업데이트\n삭제 제거\n상점\n상점 기억\n생성\n생성 검색\n생성 기억\n생성 상점\n스토어\n쓰기\n쓰기 기억\n업데이트\n업데이트 기억\n업데이트 삭제\n업데이트 편집\n에이전트 기억\n에이전트 내부\n자체 관리\n장기 기억\n저장\n제거 기억\n찾기\n찾기 기억\n쿼리 업데이트\n파일 내용\n편집\n편집 기억\n회상",
          pt: "agente memoria\napagar\narquivo\natualizar\natualizar editar\natualizar excluir\natualizar memoria\nbuscar\nbuscar atualizar\nbuscar memoria\nconsulta atualizar\ncriar\ncriar buscar\ncriar loja\ncriar memoria\ndocumento\ndocumento memoria\ndocumentos\neditar\neditar memoria\nencontrar\nencontrar memoria\nescrever\nescrever memoria\nestado interno\nexcluir\nexcluir atualizar\nexcluir excluir\nexcluir memoria\nexcluir remover\ngerenciar agente\ngestao interna\ninterno do agente\nlembrar\nlistar memoria\nloja\nloja memoria\nmemoria\nmemoria buscar\nmemoria consulta\nmemoria criar\nmemoria memoria\nnotas\nrecordar\nremover memoria\nsala consulta\nsalvar memoria\nsalvar notas",
          tl: "agent memory\nalaala\nalalahanin\nalisin memory\nburahin\nburahin alisin\nburahin burahin\nburahin i-update\nburahin memory\ndokumento\ndokumento memory\ngumawa\ngumawa maghanap\ngumawa memory\ngumawa tindahan\nhanapin\nhanapin memory\ni-edit\ni-edit memory\ni-save\ni-update\ni-update burahin\ni-update i-edit\ni-update memory\nilista\nilista memory\ninternal ng agent\ninternal state\nisulat\nisulat memory\nlong term memory\nmaghanap\nmaghanap i-update\nmaghanap memory\nmemory\nmemory gumawa\nmemory maghanap\nmemory memory\nmemory query\nnilalaman ng file\nnotes\npamahalaan agent\nquery i-update\nroom query\nsariling pamamahala\ntandaan\ntindahan\ntindahan memory",
          vi: "cap nhat\ncập nhật\ncập nhật ký ức\nchinh sua\nchỉnh sửa\nchỉnh sửa ký ức\ncua hang\ncửa hàng\ncửa hàng ký ức\nghi chu\nghi chú\nghi nho\nghi nhớ\ngỡ ký ức\nky uc\nký ức\nký ức ký ức\nký ức tạo\nký ức tìm kiếm\nliet ke\nliệt kê\nliệt kê ký ức\nlưu ghi chú\nnoi bo tac tu\nnội bộ tác tử\nquan ly\nquản lý\nquản lý tác tử\ntac tu\ntác tử\ntác tử ký ức\ntai lieu\ntài liệu\ntài liệu ký ức\ntạo cửa hàng\ntạo ký ức\ntạo tìm kiếm\ntim kiem\ntìm kiếm\ntìm kiếm ký ức\ntìm ký ức\ntu quan ly\ntự quản lý\nviết ký ức\nxóa cập nhật\nxóa gỡ\nxóa ký ức\nxóa xóa",
          "zh-CN":
            "代理 记忆\n代理内部\n保存笔记\n内部状态\n写入\n写入 记忆\n列出\n列出 记忆\n创建\n创建 商店\n创建 搜索\n创建 记忆\n删除\n删除 删除\n删除 更新\n删除 移除\n删除 记忆\n商店\n商店 记忆\n回忆\n房间 查询\n搜索\n搜索 更新\n搜索 记忆\n文件内容\n文档\n文档 记忆\n更新\n更新 删除\n更新 编辑\n更新 记忆\n查找\n查找 记忆\n查询 更新\n移除\n移除 记忆\n笔记\n管理 代理\n编辑\n编辑 记忆\n自我管理\n记住\n记忆\n记忆 创建\n记忆 搜索\n记忆 查询\n记忆 记忆\n长期记忆",
        },
      },
    },
    modelSwitch: {
      request: {
        base: "agent\nagent text\napplies\nassigns\nbetween\nchange model\nchange_model\ncloud\ncloud downloads\ndevice\ndownload\ndownload local\ndownloads\ndownloads local\neliza\nflip\nflips\ngeneral model switch\nimmediately\ninference\ninstalled\nlocal\nmissing\nmodel\nmodel switch\nmodel_switch\nname\noptionally\nrouting\nsanctioned\nselect model\nselect_model\nsettings model switch\nspecific\nstarts\nstarts download\nswitch\nswitch agent\nswitch model\nswitch to cloud\nswitch to eliza cloud\nswitch to local\nswitch_model\nswitch_to_cloud\nswitch_to_eliza_cloud\nswitch_to_local\ntarget\ntext\ntier\nuse cloud model\nuse local model\nuse on device model\nuse_cloud_model\nuse_local_model\nuse_on_device_model",
        locales: {
          es: "accion\nactivar\nagente\najustes\nchat general\nconfiguracion\nconversacion\ndescargar\ngeneral\nhablar\nherramienta\nmodelo\npreferencias\nrespuesta\nsolicitud",
          ko: "구성\n다운로드\n답변\n도구\n말하기\n모델 설정\n설정\n에이전트\n요청\n일반\n일반 대화\n작업\n채팅\n토글\n환경설정",
          pt: "acao\nagente\nalternar\nbaixar\nchat geral\nconfiguracao\nconfiguracoes\nconversa\nfalar\nferramenta\ngeral\nmodelo\npreferencias\nresposta\nsolicitacao",
          tl: "agent\naksyon\nconfiguration\ngeneral chat\ni-download\nkahilingan\nkasangkapan\nmakipag-usap\nmodel settings\npangkalahatan\npreferences\nsagot\nsettings\ntoggle\nusap",
          vi: "cai dat\ncài đặt\ncấu hình\nchung\ncong cu\ncông cụ\nhanh dong\nhành động\nnói chuyện\ntac tu\ntác tử\ntai xuong\ntải xuống\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "下载\n代理\n偏好\n回复\n回答\n对话\n工具\n开关\n操作\n普通聊天\n智能体\n模型设置\n设置\n请求\n通用\n配置",
        },
      },
    },
    notes: {
      request: {
        base: "action\naction create\naction list\nback\nback action\ncontent\ncontent field\ncreate\ncreate write\ncreate writes\ndelete\ndelete note\ndelete same\ndelete_note\ndown\ndown list\ndown write\ndurable\nfield\nfield action\nfind\nfind note\nfind_note\nfound\ngeneral notes\njot down\njot_down\nlist\nlist notes\nlist read\nlist reads\nlist_notes\nlookup note\nlookup_note\nmake note\nmake_note\nnarrowed\nnote\nnote content\nnote update\nnotes\nnotes create\nnotes notes\nnotes user\nread\nread back\nread notes\nread search\nread_notes\nreads\nremoves\nreplaces\nsame\nsame store\nsave note\nsave_note\nsearch\nsearch find\nsearch notes\nsearch_notes\nshow notes\nshow_notes\nshown\nstore\nstore notes\nsupplied\ntake note\ntake_note\ntext\nthem\nthese\nupdate\nupdate delete\nupdate note\nupdate_note\nuser\nuser write\nview\nwrite\nwrite down\nwrite note\nwrite read\nwrite_down\nwrite_note\nwrites\nwrites note",
        locales: {
          es: "accion\naccion crear\naccion listar\nactualizar\nactualizar eliminar\nborrar\nbuscar\nbuscar buscar\nchat general\ncontenido\nconversacion\ncrear\ncrear escribir\neliminar\nencontrar\nescribir\nescribir leer\ngeneral\nhablar\nherramienta\nleer\nleer buscar\nlistar\nlistar leer\nmostrar\nquitar\nrespuesta\nsolicitud\ntienda\nusuario\nusuario escribir",
          ko: "검색\n검색 찾기\n내용\n답변\n도구\n말하기\n목록\n목록 읽기\n사용자\n사용자 쓰기\n삭제\n상점\n생성\n생성 쓰기\n스토어\n쓰기\n쓰기 읽기\n업데이트\n업데이트 삭제\n요청\n일반\n일반 대화\n읽기\n읽기 검색\n작업\n작업 목록\n작업 생성\n제거\n찾기\n채팅\n콘텐츠",
          pt: "acao\nacao criar\nacao listar\napagar\natualizar\natualizar excluir\nbuscar\nbuscar encontrar\nchat geral\nconteudo\nconversa\ncriar\ncriar escrever\nencontrar\nescrever\nescrever ler\nexcluir\nfalar\nferramenta\ngeral\nler\nler buscar\nlistar\nlistar ler\nloja\nmostrar\nremover\nresposta\nsolicitacao\nusuario\nusuario escrever",
          tl: "aksyon\naksyon gumawa\naksyon ilista\nalisin\nbasahin\nbasahin maghanap\nburahin\ngeneral chat\ngumagamit\ngumawa\ngumawa isulat\nhanapin\ni-update\ni-update burahin\nilista\nilista basahin\nisulat\nisulat basahin\nkahilingan\nkasangkapan\nmaghanap\nmaghanap hanapin\nmakipag-usap\nnilalaman\npangkalahatan\nsagot\ntindahan\nusap\nuser\nuser isulat",
          vi: "cap nhat\ncập nhật\ncập nhật xóa\nchung\ncong cu\ncông cụ\ncua hang\ncửa hàng\ndoc\nđọc\nđọc tìm kiếm\ngo\ngỡ\nhanh dong\nhành động\nhành động liệt kê\nhành động tạo\nliet ke\nliệt kê\nliệt kê đọc\nnguoi dung\nngười dùng\nngười dùng viết\nnói chuyện\nnoi dung\nnội dung\ntao\ntạo\ntạo viết\ntim\ntìm\ntim kiem\ntìm kiếm\ntìm kiếm tìm\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\nviet\nviết\nviết đọc\nxoa\nxóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "内容\n写入\n写入 读取\n列出\n列出 读取\n创建\n创建 写入\n删除\n商店\n回复\n回答\n对话\n工具\n搜索\n搜索 查找\n操作\n操作 列出\n操作 创建\n普通聊天\n更新\n更新 删除\n查找\n用户\n用户 写入\n移除\n请求\n读取\n读取 搜索\n通用",
        },
      },
    },
    notify: {
      request: {
        base: "agent\nagent_internal notify\nalert\nalert user\nalerted\napp\napp alert\napproval\nautomation notify\nbody\ncategory\ncenter\ncenter app\nchat\ncompleted\nfacing\ngeneral\nhealth\nhigh\njust\nmessage\nneeded\nnormal\nnotification\nnotify\noptional\npersisted\npriority\nproactively\nprovide\npush\npush notification\npush user\npush_notification\nrather\nreminder\nreplying\nsend\nsend alert\nsend notification\nsend user\nsend_alert\nsend_notification\nshort\nshould\nsomething\nsurfaced\nsurfaced app\nsystem\ntask\nthan\ntheir\ntitle\nurgent\nuser\nuser facing\nuser notification\nworkflow",
        locales: {
          es: "accion\nagente\naplicacion\napp\nautomatizacion\nchat\nconversacion\ncron\ndisparador\nenviar\nenviar usuario\nestado interno\nflujo de trabajo\ngeneral\ngestion interna\nherramienta\ninterno del agente\nmensaje\nmonitor\nrecordatorio\nsalud\nsolicitud\ntarea\nusuario",
          ko: "건강\n내부 상태\n대화\n도구\n리마인더\n메시지\n모니터\n보내기\n보내기 사용자\n사용자\n알림\n앱\n에이전트\n에이전트 내부\n요청\n워크플로\n일반\n자동화\n자체 관리\n작업\n채팅\n크론\n트리거",
          pt: "acao\nagente\naplicativo\napp\nautomacao\nchat\nconversa\ncron\nenviar\nenviar usuario\nestado interno\nferramenta\nfluxo de trabalho\ngatilho\ngeral\ngestao interna\ninterno do agente\nlembrete\nmensagem\nmonitor\nsaude\nsolicitacao\ntarefa\nusuario",
          tl: "agent\naksyon\napp\nautomation\nchat\ncron\ngawain\ngumagamit\ninternal ng agent\ninternal state\nipadala\nipadala user\nkahilingan\nkalusugan\nkasangkapan\nmensahe\nmonitor\npaalala\npangkalahatan\nsariling pamamahala\ntrigger\nusap\nuser\nworkflow",
          vi: "chung\ncong cu\ncông cụ\ngui\ngửi\ngửi người dùng\nhanh dong\nhành động\nkich hoat\nnguoi dung\nngười dùng\nnhac nho\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnoi bo tac tu\nnội bộ tác tử\nquy trinh\nquy trình\nsuc khoe\nsức khỏe\ntac tu\ntác tử\ntin nhan\ntin nhắn\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntu quan ly\ntự quản lý\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理内部\n任务\n健康\n内部状态\n发送\n发送 用户\n定时\n工作流\n工具\n应用\n提醒\n操作\n智能体\n消息\n用户\n监控\n聊天\n自动化\n自我管理\n触发器\n请求\n通用",
        },
      },
    },
    oauth: {
      request: {
        base: "accounts\nadd connection\nadd_connection\nairtable\nasana\nauthorize app\nauthorize_app\ncheck\ncheck connection\ncheck_connection\ncloud\ncloud oauth\ncompleted\nconnect\nconnect account\nconnect oauth\nconnect start\nconnect_account\nconnect_oauth\nconnected\nconnected apps\nconnection\nconnection status\nconnection_status\nconnections\nconnections operations\nconnectors oauth\ndid it work\ndid_it_work\ndisconnect\ndisconnect account\ndisconnect oauth\ndone\ndropbox\nexplicitly\nfinished\nflow\nget\ngithub\ngoogle\ninferred\nis connected\nis_connected\njira\nlinear\nlink account\nlink integration\nlink_account\nlink_integration\nlinkedin\nlist\nlist connections\nlist_connections\nmanage\nmanage cloud\nmessage\nmicrosoft\nmy accounts\nmy integrations\nnotion\noauth\noauth connect\noauth connections\noauth flow\noauth get\noauth list\noauth revoke\noauth_connect\noauth_get\noauth_list\noauth_revoke\noperations\noperations connect\nplatform\nplatforms\nprovided\nremove connection\nrevoke\nrevoke connection\nsalesforce\nsecrets oauth\nsettings oauth\nshow\nshow connections\nshow integrations\nslack\nstart\nstart oauth\nstatus\nsupported\ntext\ntwitter\nunlink account\nverify connection\nwhat is connected\nzoom",
        locales: {
          es: "accion\nactivar\nadministrar\nagregar\najustes\nanadir\naplicacion\napp\nautorizacion\nclave api\ncomprobar\nconectar\nconectar cuenta\nconectar oauth\nconector\nconector oauth\nconfiguracion\ncontraseña\ncredencial\ncuenta\ncuenta conectada\neliminar\nestado\ngestionar\nherramienta\ninferido\nintegracion\nlinear\nlistar\nmcp\nmensaje\nmodelo\nmostrar\noauth\noauth conectar\noauth listar\noauth obtener\nobtener\noperacion\noperacion conectar\npreferencias\nquitar\nrevisar\nsecreto\nsecretos\nsolicitud\ntoken",
          ko: "api 키\noauth\noauth 가져오기\noauth 목록\noauth 연결\n가져오기\n계정\n계정 연결\n관리\n구성\n도구\n리니어\n메시지\n모델 설정\n목록\n비밀\n비밀번호\n상태\n설정\n시크릿\n앱\n연결\n연결 oauth\n연결 계정\n오어스\n요청\n인증\n자격 증명\n작업\n작업 연결\n제거\n추가\n추론\n커넥터\n커넥터 oauth\n토글\n토큰\n통합\n확인\n환경설정",
          pt: "acao\nadicionar\nalternar\naplicativo\napp\nautorizacao\nchave api\nconectar\nconectar conta\nconectar oauth\nconector\nconector oauth\nconfiguracao\nconfiguracoes\nconta\nconta conectada\ncredencial\nestado\nferramenta\ngerenciar\ninferido\nintegracao\nlinear\nlistar\nmcp\nmensagem\nmodelo\nmostrar\noauth\noauth conectar\noauth listar\noauth obter\nobter\noperacao\noperacao conectar\npreferencias\nremover\nsegredo\nsegredos\nsenha\nsolicitacao\nstatus\ntoken\nverificar",
          tl: "account\naccount connection\naksyon\nalisin\napi key\napp\nconfiguration\nconnector\nconnector oauth\ncredential\nhinula\nidagdag\nikonekta\nikonekta account\nikonekta oauth\nilista\nintegration\nkahilingan\nkasangkapan\nkunin\nkuwenta\nlinear\nmensahe\nmodel settings\noauth\noauth ikonekta\noauth ilista\noauth kunin\noperasyon\noperasyon ikonekta\npamahalaan\npassword\npreferences\nsecret\nsettings\nstatus\nsuriin\ntoggle\ntoken",
          vi: "bi mat\nbí mật\ncai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nket noi\nkết nối\nkết nối oauth\nkết nối tài khoản\nkhoa api\nkhóa api\nkiem tra\nkiểm tra\nliet ke\nliệt kê\nmật khẩu\noauth\noauth kết nối\noauth lấy\noauth liệt kê\nquan ly\nquản lý\nsuy luan\nsuy luận\ntai khoan\ntài khoản\nthao tac\nthao tác\nthao tác kết nối\ntich hop\ntích hợp\ntin nhan\ntin nhắn\ntoken\ntrang thai\ntrạng thái\ntuy chon\ntùy chọn\nung dung\nứng dụng\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN":
            "API 密钥\nlinear\noauth\noauth 列出\noauth 获取\noauth 连接\n令牌\n偏好\n凭据\n列出\n密码\n密钥\n工具\n应用\n开关\n授权\n推断\n操作\n操作 连接\n检查\n模型设置\n消息\n添加\n状态\n秘密\n移除\n管理\n获取\n设置\n请求\n账号\n账号连接\n账户\n连接\n连接 oauth\n连接 账户\n连接器\n连接器 oauth\n配置\n集成",
        },
      },
    },
    ownerFinances: {
      request: {
        base: "charges\ndashboard\nfinances\nimports\nowner\nowner finances\nowner_finances\nrecurring\nsources\nsources transactions\nspending\nsubscription\nsubscriptions\ntransactions\ntransactions spending",
        locales: {
          es: "accion\nherramienta\nsolicitud\ntransaccion",
          ko: "거래\n도구\n요청\n작업",
          pt: "acao\nferramenta\nsolicitacao\ntransacao",
          tl: "aksyon\nkahilingan\nkasangkapan\ntransaksyon",
          vi: "cong cu\ncông cụ\ngiao dich\ngiao dịch\nhanh dong\nhành động\nyeu cau\nyêu cầu",
          "zh-CN": "交易\n工具\n操作\n请求",
        },
      },
    },
    ownerGoals: {
      request: {
        base: "actions\nactions create\ncadenced\ncadenced goals\ncarry\ncheck\ncheck whose\ncheckin\ncheckin goals\ncreate\ncreate update\ndelete\ndelete review\ndrives\nfeed\ngeneration\nget\nget scheduled\ngoals\ngoals actions\ngoals carry\ngoals create\ngoals get\nhorizon\nlife\nlife goals\nlife_goals\nlong\nmanage\nmanage owner\nowner\nowner goals\nowner_goals\nquarter\nrecorded\nreminder\nreminder generation\nresponses\nreview\nreview goals\nreview_goals\nroutine\nroutine reminder\nroutines\nscheduled\nscheduled check\nset goal\nset_goal\nupdate\nupdate delete\nupdate goal\nupdate_goal\nwhose\nyear",
        locales: {
          es: "accion\naccion crear\nactualizar\nactualizar eliminar\nactualizar meta\nadministrar\nborrar\ncomprobar\ncrear\ncrear actualizar\neliminar\ngestionar\nherramienta\nmeta\nmeta accion\nmeta crear\nmeta obtener\nobjetivo\nobtener\nrecordatorio\nrevisar\nsolicitud",
          ko: "가져오기\n관리\n도구\n리마인더\n목표\n목표 가져오기\n목표 생성\n목표 작업\n삭제\n생성\n생성 업데이트\n알림\n업데이트\n업데이트 목표\n업데이트 삭제\n요청\n작업\n작업 생성\n확인",
          pt: "acao\nacao criar\napagar\natualizar\natualizar excluir\natualizar meta\ncriar\ncriar atualizar\nexcluir\nferramenta\ngerenciar\nlembrete\nmeta\nmeta acao\nmeta criar\nmeta obter\nobjetivo\nobter\nsolicitacao\nverificar",
          tl: "aksyon\naksyon gumawa\nburahin\ngumawa\ngumawa i-update\ni-update\ni-update burahin\ni-update layunin\nkahilingan\nkasangkapan\nkunin\nlayunin\nlayunin aksyon\nlayunin gumawa\nlayunin kunin\npaalala\npamahalaan\nsuriin",
          vi: "cap nhat\ncập nhật\ncập nhật mục tiêu\ncập nhật xóa\ncong cu\ncông cụ\nhanh dong\nhành động\nhành động tạo\nkiem tra\nkiểm tra\nlay\nlấy\nmuc tieu\nmục tiêu\nmục tiêu hành động\nmục tiêu lấy\nmục tiêu tạo\nnhac nho\nnhắc nhở\nquan ly\nquản lý\ntao\ntạo\ntạo cập nhật\nxoa\nxóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "创建\n创建 更新\n删除\n工具\n提醒\n操作\n操作 创建\n更新\n更新 删除\n更新 目标\n检查\n目标\n目标 创建\n目标 操作\n目标 获取\n管理\n获取\n请求",
        },
      },
    },
    ownerHealth: {
      request: {
        base: "fitbit\nfitness\ngoogle\nhealth\nhealth google\nhealth telemetry\nhealth today\nmetric\nmetric status\nonly\noura\nowner\nowner health\nowner_health\nread\nread only\nreads\nreads health\nstatus\nstatus read\nstrava\ntelemetry\ntelemetry reads\ntoday\ntrend\nwellness\nwithings",
        locales: {
          es: "accion\nestado\nestado leer\nherramienta\nleer\nleer salud\nsalud\nsalud google\nsolicitud",
          ko: "건강\n건강 google\n도구\n상태\n상태 읽기\n요청\n읽기\n읽기 건강\n작업",
          pt: "acao\nestado\nferramenta\nler\nler saude\nsaude\nsaude google\nsolicitacao\nstatus\nstatus ler",
          tl: "aksyon\nbasahin\nbasahin kalusugan\nkahilingan\nkalusugan\nkalusugan google\nkasangkapan\nstatus\nstatus basahin",
          vi: "cong cu\ncông cụ\ndoc\nđọc\nđọc sức khỏe\nhanh dong\nhành động\nsuc khoe\nsức khỏe\nsức khỏe google\ntrang thai\ntrạng thái\ntrạng thái đọc\nyeu cau\nyêu cầu",
          "zh-CN":
            "健康\n健康 google\n工具\n操作\n状态\n状态 读取\n请求\n读取\n读取 健康",
        },
      },
    },
    ownerRoutines: {
      request: {
        base: "also\nalso update\nbrush\nbuilds\nchat\nchat brush\nchat daily\ncomplete\ncomplete skip\ncreate\ncreate habit\ncreate recurring task\ncreate routine\ncreate_habit\ncreate_recurring_task\ncreate_routine\ndaily\ndaily habit\ndaily task\ndaily_habit\ndaily_task\ndefinition\ndefinition reminder\ndelete\ndelete complete\nevery\nhabit\nhabit chat\nhabits\ninference\ninspect\nmeditate\nnew habit\nnew_habit\nowner\nowner routines\nowner_routines\npassive\npassive schedule\nplan\nplan also\nplan update\nrecurring\nrecurring task\nrecurring_task\nreminder\nreminder plan\nreview\nreview schedule\nroutine\nroutine chat\nroutines\nroutines create\nsave\nsave habit\nsave_habit\nschedule\nschedule inference\nschedule summary\nskip\nsnooze\nsummary\nteeth\ntimes\ntimes reminder\ntrack habit\ntrack_habit\nupdate\nupdate delete\nweekly\nweekly task\nweekly_task",
        locales: {
          es: "accion\nactualizar\nactualizar eliminar\nagendar\nborrar\nchat\ncompletar\nconversacion\ncrear\ncrear tarea\neliminar\neliminar completar\nherramienta\nplan\nplan actualizar\nprogramar\nrecordatorio\nrecordatorio plan\nsolicitud\ntarea\nterminar",
          ko: "계획\n계획 업데이트\n대화\n도구\n리마인더\n리마인더 계획\n삭제\n삭제 완료\n생성\n생성 작업\n알림\n업데이트\n업데이트 삭제\n예약\n완료\n요청\n일정\n작업\n채팅",
          pt: "acao\nagendar\napagar\natualizar\natualizar excluir\nchat\ncompletar\nconcluir\nconversa\ncriar\ncriar tarefa\nexcluir\nexcluir concluir\nferramenta\nlembrete\nlembrete plano\nplano\nplano atualizar\nsolicitacao\ntarefa",
          tl: "aksyon\nburahin\nburahin tapusin\nchat\ngawain\ngumawa\ngumawa gawain\ni-schedule\ni-update\ni-update burahin\nkahilingan\nkasangkapan\npaalala\npaalala plano\nplano\nplano i-update\ntapusin\nusap",
          vi: "cap nhat\ncập nhật\ncập nhật xóa\ncong cu\ncông cụ\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nke hoach\nkế hoạch\nkế hoạch cập nhật\nlen lich\nlên lịch\nnhac nho\nnhắc nhở\nnhắc nhở kế hoạch\nnhiem vu\nnhiệm vụ\ntao\ntạo\ntạo nhiệm vụ\ntro chuyen\ntrò chuyện\nxoa\nxóa\nxóa hoàn thành\nyeu cau\nyêu cầu",
          "zh-CN":
            "任务\n创建\n创建 任务\n删除\n删除 完成\n安排\n完成\n工具\n提醒\n提醒 计划\n操作\n更新\n更新 删除\n聊天\n计划\n计划 更新\n请求",
        },
      },
    },
    ownerScreentime: {
      request: {
        base: "activity\nactivity analytics\nactivity app\nactivity report\nactivity time\nactivity_report\nanalytics\napp\napp time\napp usage\napp website\nbrowser\nlocal\nlocal activity\nowner\nowner screen\nowner screentime\nowner_screentime\nscreen\nscreen time\nscreen_time\nscreentime\nsite\nsummary\ntime\ntime activity\ntime app\ntoday\nusage\nusage browser\nwebsite\nwebsite activity\nweekly\nweekly app",
        locales: {
          es: "accion\nactividad\nactividad aplicacion\naplicacion\naplicacion sitio web\napp\nherramienta\nnavegador\npantalla\nsitio web\nsitio web actividad\nsolicitud",
          ko: "도구\n브라우저\n앱\n앱 웹사이트\n요청\n웹사이트\n웹사이트 활동\n작업\n화면\n활동\n활동 앱",
          pt: "acao\naplicativo\naplicativo site\napp\natividade\natividade aplicativo\nferramenta\nnavegador\nsite\nsite atividade\nsolicitacao\ntela",
          tl: "aksyon\naktibidad\naktibidad app\napp\napp website\nbrowser\nkahilingan\nkasangkapan\nscreen\nwebsite\nwebsite aktibidad",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nhoat dong\nhoạt động\nhoạt động ứng dụng\nman hinh\nmàn hình\ntrang web\ntrang web hoạt động\ntrinh duyet\ntrình duyệt\nung dung\nứng dụng\nứng dụng trang web\nyeu cau\nyêu cầu",
          "zh-CN":
            "屏幕\n工具\n应用\n应用 网站\n操作\n活动\n活动 应用\n浏览器\n网站\n网站 活动\n请求",
        },
      },
    },
    pageDelegate: {
      request: {
        base: "action\naction child\nautomation tools\nautomation_tools\nbrowser\nbrowser tools\nbrowser wallet\nbrowser_tools\ncharacter tools\ncharacter_tools\nchild\nconnector tools\nconnector_tools\nconnectors\nconnectors phone\ndelegate\ndelegate page\ngeneral page delegate\nowner\nowner action\nowner tools\nowner_tools\npage\npage actions\npage browser\npage delegate\npage_actions\npage_delegate\npersonal assistant actions\npersonal_assistant_actions\nphone\nphone tools\nphone_tools\nsettings\nsettings connectors\nsettings tools\nsettings_tools\nwallet\nwallet settings\nwallet tools\nwallet_tools",
        locales: {
          es: "accion\nautomatizacion\nautomatizacion herramienta\nbilletera\nbilletera configuracion\nbilletera herramienta\nchat general\nconector\nconector herramienta\nconfiguracion\nconfiguracion conector\nconfiguracion herramienta\nconversacion\ngeneral\ngeneral pagina\nhablar\nherramienta\nnavegador\nnavegador billetera\nnavegador herramienta\npagina\npagina accion\npagina navegador\npersonaje\npersonaje herramienta\nrespuesta\nsolicitud\nwallet",
          ko: "답변\n도구\n말하기\n브라우저\n브라우저 도구\n브라우저 지갑\n설정\n설정 도구\n설정 커넥터\n요청\n일반\n일반 대화\n일반 페이지\n자동화\n자동화 도구\n작업\n지갑\n지갑 도구\n지갑 설정\n채팅\n캐릭터\n캐릭터 도구\n커넥터\n커넥터 도구\n페이지\n페이지 브라우저\n페이지 작업",
          pt: "acao\nautomacao\nautomacao ferramenta\ncarteira\ncarteira configuracoes\ncarteira ferramenta\nchat geral\nconector\nconector ferramenta\nconfiguracoes\nconfiguracoes conector\nconfiguracoes ferramenta\nconversa\nfalar\nferramenta\ngeral\ngeral pagina\nnavegador\nnavegador carteira\nnavegador ferramenta\npagina\npagina acao\npagina navegador\npersonagem\npersonagem ferramenta\nresposta\nsolicitacao\nwallet",
          tl: "aksyon\nautomation\nautomation tool\nbrowser\nbrowser tool\nbrowser wallet\nconnector\nconnector tool\ngeneral chat\nkahilingan\nkarakter\nkarakter tool\nkasangkapan\nmakipag-usap\npahina\npahina aksyon\npahina browser\npangkalahatan\npangkalahatan pahina\nsagot\nsettings\nsettings connector\nsettings tool\ntool\nusap\nwallet\nwallet settings\nwallet tool",
          vi: "cai dat\ncài đặt\ncài đặt công cụ\ncài đặt kết nối\nchung\nchung trang\ncong cu\ncông cụ\nhanh dong\nhành động\nket noi\nkết nối\nkết nối công cụ\nnhan vat\nnhân vật\nnhân vật công cụ\nnói chuyện\ntra loi\ntrả lời\ntrang\ntrang hành động\ntrang trình duyệt\ntrinh duyet\ntrình duyệt\ntrình duyệt công cụ\ntrình duyệt ví\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntự động hóa công cụ\nvi\nví\nví cài đặt\nví công cụ\nyeu cau\nyêu cầu",
          "zh-CN":
            "回复\n回答\n对话\n工具\n操作\n普通聊天\n浏览器\n浏览器 工具\n浏览器 钱包\n自动化\n自动化 工具\n角色\n角色 工具\n设置\n设置 工具\n设置 连接器\n请求\n连接器\n连接器 工具\n通用\n通用 页面\n钱包\n钱包 工具\n钱包 设置\n页面\n页面 操作\n页面 浏览器",
        },
      },
    },
    payment: {
      request: {
        base: "abort payment request\nabort_payment_request\naction\naction create\nactive\nactive mysticism\namount\nask\nask for payment\nask user\nask_for_payment\nawait\nawait payment settlement\nawait_payment_settlement\ncallback\ncancel\ncancel request\ncharge user\ncharge_user\ncheck\ncheck payment\ncheck payment proof\ncheck read\ncheck request\ncheck_payment\ncheck_payment_proof\nconfirm payment\nconfirm_payment\ncreate\ncreate request\ndeliver\ndispatch payment link\ndispatch_payment_link\nfinalize payment\nfinalize_payment\nfinance payment\ninclude\ninclude message\nlink\nmessage\nmysticism\nmysticism payment\nnew payment request\nnew_payment_request\nopen payment request\nopen_payment_request\npay\npay amount\npayload\npayment\npayment action\npayment check\npayment create\npayment router\npayment status\npayment_status\npayments payment\nread\nread payment\nreading\nrequest\nrequest ask\nrequest deliver\nrequest payment\nrequest_payment\nrouter\nrouter active\nsend payment link\nsend_payment_link\nsession\nsession check\nset price\nset_price\nsettle\nstatus\nstatus request\nuser\nuser pay\nverify\nverify payment\nverify payment proof\nverify_payment\nverify_payment_proof\nvoid payment request\nvoid_payment_request\nwait for payment\nwait_for_payment",
        locales: {
          es: "abrir\nabrir pago solicitud\naccion\naccion crear\nactivo\ncheckout\ncobro\ncomprobar\ncrear\ncrear solicitud\nenviar\nenviar pago\nestado\nfactura\nherramienta\nleer\nleer pago\nmensaje\npagar\npago\npago accion\npago crear\npago estado\npago pago\npago revisar\npago solicitud\npedir\npreguntar\npreguntar pago\npreguntar usuario\nrevisar\nrevisar leer\nrevisar pago\nrevisar solicitud\nsolicitud\nsolicitud pago\nsolicitud preguntar\nusuario",
          ko: "결제\n결제 결제\n결제 상태\n결제 생성\n결제 요청\n결제 작업\n결제 확인\n도구\n메시지\n보내기\n보내기 결제\n사용자\n상태\n생성\n생성 요청\n열기\n열기 결제 요청\n요금\n요청\n요청 결제\n요청 질문\n읽기\n읽기 결제\n작업\n작업 생성\n지불\n질문\n질문 결제\n질문 사용자\n청구서\n체크아웃\n확인\n확인 결제\n확인 요청\n확인 읽기\n활성",
          pt: "abrir\nabrir pagamento solicitacao\nacao\nacao criar\nativo\ncheckout\ncobranca\ncriar\ncriar solicitacao\nenviar\nenviar pagamento\nestado\nfatura\nferramenta\nler\nler pagamento\nmensagem\npagamento\npagamento acao\npagamento criar\npagamento pagamento\npagamento solicitacao\npagamento status\npagamento verificar\npagar\npedir\nperguntar\nperguntar pagamento\nperguntar usuario\nsolicitacao\nsolicitacao pagamento\nsolicitacao perguntar\nstatus\nusuario\nverificar\nverificar ler\nverificar pagamento\nverificar solicitacao",
          tl: "aksyon\naksyon gumawa\naktibo\nbasahin\nbasahin bayad\nbayad\nbayad aksyon\nbayad bayad\nbayad gumawa\nbayad kahilingan\nbayad status\nbayad suriin\nbilling\nbuksan\nbuksan bayad kahilingan\ncheckout\ngumagamit\ngumawa\ngumawa kahilingan\nhiling\ninvoice\nipadala\nipadala bayad\nkahilingan\nkahilingan bayad\nkahilingan magtanong\nkasangkapan\nmagbayad\nmagtanong\nmagtanong bayad\nmagtanong user\nmensahe\nstatus\nsuriin\nsuriin basahin\nsuriin bayad\nsuriin kahilingan\nuser",
          vi: "cong cu\ncông cụ\ndang hoat dong\nđang hoạt động\nđọc thanh toán\ngui\ngửi\ngửi thanh toán\nhanh dong\nhành động\nhành động tạo\nhoa don\nhóa đơn\nhỏi\nhỏi người dùng\nhỏi thanh toán\nkiem tra\nkiểm tra\nkiểm tra đọc\nkiểm tra thanh toán\nkiểm tra yêu cầu\nmo\nmở\nmở thanh toán yêu cầu\nnguoi dung\nngười dùng\ntao\ntạo\ntạo yêu cầu\nthanh toan\nthanh toán\nthanh toán hành động\nthanh toán kiểm tra\nthanh toán tạo\nthanh toán thanh toán\nthanh toán trạng thái\nthanh toán yêu cầu\ntin nhan\ntin nhắn\ntính tiền\ntra tien\ntrả tiền\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu\nyêu cầu hỏi\nyêu cầu thanh toán",
          "zh-CN":
            "付款\n付款 付款\n付款 创建\n付款 操作\n付款 检查\n付款 状态\n付款 请求\n创建\n创建 请求\n发票\n发送\n发送 付款\n工具\n打开\n打开 付款 请求\n操作\n操作 创建\n支付\n检查\n检查 付款\n检查 请求\n检查 读取\n活跃\n消息\n状态\n用户\n结账\n询问\n询问 付款\n询问 用户\n请求\n请求 付款\n请求 询问\n读取\n读取 付款\n账单",
        },
      },
    },
    personalAssistant: {
      request: {
        base: "action\naction book\naction scheduling\naction sign\napproval\nassistant\nassistant workflows\nbook\nbook travel\nbooking\nbooking action\ncalendar personal assistant\ndocument\ndocument signature\ndocusign\ngeneral personal assistant\nnegotiation\nnegotiation action\nowner\npersonal\npersonal assistant\npersonal_assistant\nqueue\nscheduling\nsign\nsign document\nsign_document\nsignature\ntasks personal assistant\ntravel\ntravel book flight\ntravel book hotel\ntravel booking\ntravel capture preferences\ntravel personal assistant\ntravel rebook after conflict\ntravel scheduling\ntravel sync itinerary to calendar\ntravel travel\ntravel_book_flight\ntravel_book_hotel\ntravel_capture_preferences\ntravel_rebook_after_conflict\ntravel_sync_itinerary_to_calendar\nworkflows\nworkflows action",
        locales: {
          es: "accion\naccion reservar\ncalendario\ncapturar\nchat general\nconversacion\ndocumento\nfecha limite\nflujo de trabajo\nflujo de trabajo accion\ngeneral\nhablar\nherramienta\npendiente\nrecordatorio\nreservar\nreservar viaje\nrespuesta\nseguimiento\nsolicitud\ntarea\ntareas\nviaje\nviaje calendario\nviaje capturar\nviaje reservar\nviaje viaje",
          ko: "답변\n도구\n리마인더\n마감일\n말하기\n문서\n여행\n여행 여행\n여행 예약\n여행 캘린더\n여행 캡처\n예약\n예약 여행\n요청\n워크플로\n워크플로 작업\n일반\n일반 대화\n일정\n작업\n작업 예약\n채팅\n캘린더\n캡처\n할 일\n후속 조치",
          pt: "acao\nacao reservar\nacompanhamento\nafazer\ncalendario\ncapturar\nchat geral\nconversa\ndocumento\nfalar\nferramenta\nfluxo de trabalho\nfluxo de trabalho acao\ngeral\nlembrete\nprazo\nreservar\nreservar viagem\nresposta\nsolicitacao\ntarefa\ntarefas\nviagem\nviagem calendario\nviagem capturar\nviagem reservar\nviagem viagem",
          tl: "aksyon\naksyon mag-book\nbiyahe\nbiyahe biyahe\nbiyahe kalendaryo\nbiyahe kuha\nbiyahe mag-book\ndeadline\ndokumento\nfollow up\ngawain\ngeneral chat\nireserba\nkahilingan\nkalendaryo\nkasangkapan\nkuha\nmag-book\nmag-book biyahe\nmakipag-usap\npaalala\npangkalahatan\nsagot\ntask\ntodo\nusap\nworkflow\nworkflow aksyon",
          vi: "chung\nchup\nchụp\ncong cu\ncông cụ\ndat\nđặt\nđặt du lịch\ndu lich\ndu lịch\ndu lịch chụp\ndu lịch đặt\ndu lịch du lịch\ndu lịch lịch\nhanh dong\nhành động\nhành động đặt\nlich\nlịch\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnói chuyện\nquy trinh\nquy trình\nquy trình hành động\ntac vu\ntác vụ\ntai lieu\ntài liệu\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "任务\n回复\n回答\n对话\n工作流\n工作流 操作\n工具\n待办\n截图\n截止日期\n捕获\n提醒\n操作\n操作 预订\n文档\n旅行\n旅行 捕获\n旅行 旅行\n旅行 日历\n旅行 预订\n日历\n普通聊天\n请求\n跟进\n通用\n预订\n预订 旅行",
        },
      },
    },
    personality: {
      request: {
        base: "add\nadmin\nadmin personality\naffects\nagent\nagent_internal personality\nbe colder\nbe less responsive\nbe more agreeable\nbe nicer\nbe quiet\nbe terse\nbe verbose\nbe warmer\nbe_colder\nbe_less_responsive\nbe_more_agreeable\nbe_nicer\nbe_quiet\nbe_terse\nbe_verbose\nbe_warmer\nchange tone\nchange_tone\nchanges\nclear\ndirective\ndirectives\ngate\ngeneral personality\nglobal\ninspecting\nlift\nlist\nlisting\nload\nmanage\nmedia personality\nonly\npersonality\npreferences\nprofile\nprofiles\nreply\nrequester\nrequired\nrequires\nsave\nsaving\nscope\nset personality\nset_personality\nsettings personality\nshared\nshow\nshut up\nshut_up\nstate\nsubactions\ntrait\nuser\nwide",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrar\nagente\nagregar\najustes\nanadir\naudio\nborrar\ncaptura\nchat general\nconfiguracion\nconversacion\ndueño\nestado interno\ngeneral\ngestion interna\ngestionar\nhablar\nherramienta\nimagen\ninterno del agente\nlimpiar\nlistar\nmodelo\nmostrar\nmultimedia\nperfil\npermisos\npolitica\npreferencias\nresponder\nrespuesta\nroles\nsolicitud\ntranscripcion\nusuario\nvideo",
          ko: "관리\n관리자\n구성\n권한\n내부 상태\n답변\n답장\n도구\n말하기\n모델 설정\n목록\n미디어\n비디오\n사용자\n설정\n소유자\n스크린샷\n에이전트\n에이전트 내부\n역할\n오디오\n요청\n이미지\n일반\n일반 대화\n자체 관리\n작업\n전사\n정책\n지우기\n채팅\n추가\n토글\n프로필\n환경설정",
          pt: "acao\nadicionar\nadministrador\nagente\nalternar\naudio\ncaptura\nchat geral\nconfiguracao\nconfiguracoes\nconversa\ndono\nestado interno\nfalar\nferramenta\nfuncoes\ngeral\ngerenciar\ngestao interna\nimagem\ninterno do agente\nlimpar\nlistar\nmidia\nmodelo\nmostrar\nperfil\npermissoes\npolitica\npreferencias\nresponder\nresposta\nsolicitacao\ntranscricao\nusuario\nvideo",
          tl: "admin\nagent\naksyon\naudio\nconfiguration\ngeneral chat\ngumagamit\nidagdag\nilista\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nlarawan\nlinisin\nmakipag-usap\nmay ari\nmedia\nmodel settings\npahintulot\npamahalaan\npangkalahatan\npatakaran\npreferences\nprofile\nrole\nsagot\nsariling pamamahala\nscreenshot\nsettings\nsumagot\ntoggle\ntranscript\nusap\nuser\nvideo",
          vi: "âm thanh\ncai dat\ncài đặt\ncấu hình\nchu so huu\nchủ sở hữu\nchung\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nhanh dong\nhành động\nhinh anh\nhình ảnh\nho so\nhồ sơ\nliet ke\nliệt kê\nnguoi dung\nngười dùng\nnoi bo tac tu\nnội bộ tác tử\nnói chuyện\nquan ly\nquản lý\nquan tri\nquản trị\nquyen\nquyền\ntac tu\ntác tử\nthem\nthêm\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn\nvideo\nxoa\nxóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理内部\n偏好\n内部状态\n列出\n回复\n回答\n图片\n媒体\n对话\n工具\n开关\n截图\n所有者\n操作\n普通聊天\n智能体\n权限\n模型设置\n添加\n清除\n用户\n视频\n策略\n管理\n管理员\n自我管理\n角色\n设置\n请求\n资料\n转录\n通用\n配置\n音频",
        },
      },
    },
    plan: {
      request: {
        base: "action\naction create\nagent_internal plan\nautomation plan\ncode plan\ncreate\ncreate makes\ncreate plan\ncreate_plan\ndata\nfinalize\ngenerate plan\ngenerate_plan\nmake plan\nmake_plan\nmakes\nmulti\noperate\npatches\npersistence\nphase\nphase plans\nplan\nplan data\nplan project\nplan router\nplan_project\nplans\nplans update\nproject\nproject plan\nproject_plan\nready\nreturn\nreview\nrouter\nrouter action\nsupplied\nsupplied plan\ntasks plan\nupdate\nupdate review",
        locales: {
          es: "accion\naccion crear\nactualizar\nagente\nagente plan\nautomatizacion\nautomatizacion plan\ncodigo\ncodigo plan\ncrear\ncrear plan\ncron\ndepurar\ndisparador\nestado interno\nfecha limite\nflujo de trabajo\ngenerar\ngenerar plan\ngestion interna\nherramienta\nimplementar\ninterno del agente\nmonitor\npendiente\nplan\nplan actualizar\nprogramacion\nprueba\nrecordatorio\nrepositorio\nseguimiento\nsolicitud\ntarea\ntarea plan\ntareas",
          ko: "계획\n계획 업데이트\n구현\n내부 상태\n도구\n디버그\n리마인더\n마감일\n모니터\n생성\n생성 계획\n업데이트\n에이전트\n에이전트 계획\n에이전트 내부\n요청\n워크플로\n자동화\n자동화 계획\n자체 관리\n작업\n작업 계획\n작업 생성\n저장소\n코드\n코드 계획\n크론\n테스트\n트리거\n프로그래밍\n할 일\n후속 조치",
          pt: "acao\nacao criar\nacompanhamento\nafazer\nagente\nagente plano\natualizar\nautomacao\nautomacao plano\ncodigo\ncodigo plano\ncriar\ncriar plano\ncron\ndepurar\nestado interno\nferramenta\nfluxo de trabalho\ngatilho\ngerar\ngerar plano\ngestao interna\nimplementar\ninterno do agente\nlembrete\nmonitor\nplano\nplano atualizar\nprazo\nprogramacao\nrepositorio\nsolicitacao\ntarefa\ntarefa plano\ntarefas\nteste",
          tl: "agent\nagent plano\naksyon\naksyon gumawa\nautomation\nautomation plano\nbumuo\nbumuo plano\ncode\ncode plano\ncron\ndeadline\ndebug\nfollow up\ngawain\ngawain plano\ngumawa\ngumawa plano\ni-update\ninternal ng agent\ninternal state\nipatupad\nkahilingan\nkasangkapan\nmonitor\npaalala\nplano\nplano i-update\nprogramming\nrepo\nsariling pamamahala\ntask\ntest\ntodo\ntrigger\nworkflow",
          vi: "cap nhat\ncập nhật\ncong cu\ncông cụ\nhanh dong\nhành động\nhành động tạo\nke hoach\nkế hoạch\nkế hoạch cập nhật\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nma\nmã\nmã kế hoạch\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnhiệm vụ kế hoạch\nnoi bo tac tu\nnội bộ tác tử\nquy trinh\nquy trình\ntac tu\ntác tử\ntác tử kế hoạch\ntac vu\ntác vụ\ntao\ntạo\ntạo kế hoạch\ntu dong hoa\ntự động hóa\ntự động hóa kế hoạch\ntu quan ly\ntự quản lý\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "仓库\n代理\n代理 计划\n代理内部\n代码\n代码 计划\n任务\n任务 计划\n内部状态\n创建\n创建 计划\n定时\n实现\n工作流\n工具\n待办\n截止日期\n提醒\n操作\n操作 创建\n智能体\n更新\n测试\n生成\n生成 计划\n监控\n编程\n自动化\n自动化 计划\n自我管理\n触发器\n计划\n计划 更新\n请求\n调试\n跟进",
        },
      },
    },
    plugin: {
      request: {
        base: "admin plugin\ncode plugin\nconfig\nconfigure\nconfigure connector\nconfigure plugin\nconfigure read\nconfigure toggle\nconfigure_connector\nconfigure_plugin\nconnector\nconnector lifecycle\nconnector package\nconnectors plugin\ndisconnect\ndisconnect connector\ndisconnect_connector\neject\neject configure\neject plugin\neject_plugin\nfiles plugin\ninstall\ninstall plugin\ninstall uninstall\ninstall_plugin\nlifecycle\nlifecycle install\nlist\nlist connectors\nlist disconnect\nlist_connectors\nmanage\nmanage connector\nmanage plugin\nmanage_connector\nmanage_plugin\npackage\npackage install\nplugin\nplugin connector\nplugin lifecycle\nplugin_lifecycle\nread\nread config\nread plugin config\nread_plugin_config\nreinject\nreinject configure\nreinject plugin\nreinject_plugin\nsave connector config\nsave_connector_config\nsecrets plugin\nset connector enabled\nset_connector_enabled\nsettings plugin\nsync\nsync plugin\nsync_plugin\ntoggle\ntoggle connector\ntoggle list\ntoggle plugin\ntoggle_connector\ntoggle_plugin\ntype\ntype plugin\nuninstall\nuninstall plugin\nuninstall update\nuninstall_plugin\nupdate\nupdate plugin\nupdate sync\nupdate_plugin",
        locales: {
          es: "activar\nactualizar plugin\nadministrador\nadministrador plugin\najustes\narchivo\narchivo plugin\narchivos\ncarpeta\nclave api\nclave secreta\ncodigo\ncodigo plugin\nconector\nconector plugin\nconfiguracion\nconfiguracion plugin\nconfigurar conector\nconfigurar leer\nconfigurar plugin\ncontraseña\ncredencial\ncuenta conectada\ndepurar\ndueño\ngestionar conector\ngestionar plugin\nimplementar\ninstalar plugin\nintegracion\nleer archivo\nleer plugin\nlistar conector\nmcp\nmodelo\noauth\npermisos\nplugin conector\npolitica\npreferencias\nprogramacion\nprueba\nrepositorio\nroles\nsecreto\nsecreto plugin\nsecretos\ntoken",
          ko: "api 키\n계정 연결\n관리 커넥터\n관리 플러그인\n관리자\n관리자 플러그인\n구성\n구현\n권한\n디렉터리\n디버그\n모델 설정\n목록 커넥터\n비밀\n비밀 플러그인\n비밀번호\n설정\n설정 읽기\n설정 커넥터\n설정 플러그인\n설치\n설치 플러그인\n소유자\n시크릿\n업데이트 플러그인\n역할\n오어스\n읽기 플러그인\n자격 증명\n저장소\n정책\n커넥터\n커넥터 플러그인\n코드\n코드 플러그인\n테스트\n토글\n토큰\n통합\n파일\n파일 쓰기\n파일 읽기\n파일 플러그인\n폴더\n프로그래밍\n플러그인\n플러그인 커넥터\n환경설정",
          pt: "administrador\nadministrador plugin\nalternar\narquivo\narquivo plugin\narquivos\natualizar plugin\nchave api\ncodigo\ncodigo plugin\nconector\nconector plugin\nconfiguracao\nconfiguracoes\nconfiguracoes plugin\nconfigurar conector\nconfigurar ler\nconfigurar plugin\nconta conectada\ncredencial\ndepurar\ndiretorio\ndono\nfuncoes\ngerenciar conector\ngerenciar plugin\nimplementar\ninstalar plugin\nintegracao\nler arquivo\nler plugin\nlistar conector\nmcp\nmodelo\noauth\npasta\npermissoes\nplugin conector\npolitica\npreferencias\nprogramacao\nrepositorio\nsegredo\nsegredo plugin\nsegredos\nsenha\nteste\ntoken",
          tl: "account connection\nadmin\nadmin plugin\napi key\nbasahin file\nbasahin plugin\ncode\ncode plugin\nconfiguration\nconnector\nconnector plugin\ncredential\ndebug\ndirectory\nfile\nfile plugin\nfiles\nfolder\ni-configure basahin\ni-configure connector\ni-configure plugin\ni-install\ni-install plugin\ni-update plugin\nilista connector\nintegration\nipatupad\nmay ari\nmodel settings\noauth\npahintulot\npamahalaan connector\npamahalaan plugin\npassword\npatakaran\nplugin\nplugin connector\npreferences\nprogramming\nrepo\nrole\nsecret\nsecret plugin\nsettings\nsettings plugin\ntest\ntoggle\ntoken",
          vi: "bi mat\nbí mật\ncai dat\ncài đặt\ncài đặt plugin\ncap nhat\ncập nhật\ncập nhật plugin\ncau hinh\ncấu hình\ncấu hình đọc\ncấu hình kết nối\ncấu hình plugin\nchu so huu\nchủ sở hữu\nđọc plugin\ndoc tep\nđọc tệp\nket noi\nkết nối\nkết nối plugin\nkho ma\nkho mã\nkhoa api\nkhóa api\nkiểm thử\nlap trinh\nlập trình\nliet ke\nliệt kê\nliệt kê kết nối\nmã plugin\nmật khẩu\nquan ly\nquản lý\nquản lý kết nối\nquản lý plugin\nquan tri\nquản trị\nquản trị plugin\ntài khoản\ntệp plugin\nthu muc\nthư mục\ntich hop\ntích hợp\ntuy chon\ntùy chọn",
          "zh-CN":
            "API 密钥\n仓库\n代码\n代码 插件\n令牌\n偏好\n写文件\n凭据\n列出 连接器\n安装 插件\n实现\n密码\n密钥\n密钥 插件\n开关\n所有者\n授权\n插件\n插件 连接器\n文件\n文件 插件\n文件夹\n更新 插件\n权限\n模型设置\n测试\n目录\n秘密\n策略\n管理 插件\n管理 连接器\n管理员\n管理员 插件\n编程\n角色\n设置\n设置 插件\n读取 插件\n读取文件\n调试\n账号连接\n连接器\n连接器 插件\n配置\n配置 插件\n配置 读取\n配置 连接器\n集成",
        },
      },
    },
    pollPluginConfigStatus: {
      request: {
        base: "check plugin ready\ncheck_plugin_ready\nconfig\nconfig keys\nkeys\nkeys satisfied\nmissing\nplugin\nplugin config\nplugin config ready\nplugin required\nplugin_config_ready\npoll\npoll plugin\npoll plugin config status\npoll_plugin_config_status\nready\nreports\nrequired\nsatisfied\nwhether\nwhether plugin",
        locales: {
          es: "accion\nclave\ncomplemento\ncomprobar\nestado\nherramienta\nplugin\nplugin estado\nrevisar\nrevisar plugin\nsolicitud\ntecla",
          ko: "도구\n상태\n요청\n작업\n키\n플러그인\n플러그인 상태\n확인\n확인 플러그인",
          pt: "acao\nchave\nestado\nferramenta\nplugin\nplugin status\nsolicitacao\nstatus\ntecla\nverificar\nverificar plugin",
          tl: "aksyon\nkahilingan\nkasangkapan\nkey\nplugin\nplugin status\nstatus\nsuriin\nsuriin plugin",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nkhoa\nkhóa\nkiem tra\nkiểm tra\nkiểm tra plugin\nphim\nphím\nplugin\nplugin trạng thái\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu",
          "zh-CN":
            "密钥\n工具\n插件\n插件 状态\n操作\n检查\n检查 插件\n状态\n请求\n键",
        },
      },
    },
    post: {
      request: {
        base: "cast\nconnectors post\nfeed post\nfeed_post\npost\npublish\nsocial posting post\nsocial_posting post\ntimeline\ntweet",
        locales: {
          es: "accion\nconector\nconector publicacion\ncuenta conectada\nherramienta\nintegracion\nlinea de tiempo\nmcp\noauth\npost\npublicacion\npublicar\nrespuesta publica\nsocial\nsocial publicacion\nsolicitud\ntuit",
          ko: "게시\n게시물\n계정 연결\n공개 답글\n도구\n발행\n소셜\n소셜 게시물\n오어스\n요청\n작업\n커넥터\n커넥터 게시물\n타임라인\n통합\n트윗",
          pt: "acao\nconector\nconector postagem\nconta conectada\nferramenta\nintegracao\nlinha do tempo\nmcp\noauth\npostagem\npostar\npublicar\nresposta publica\nsocial\nsocial postagem\nsolicitacao\ntweet",
          tl: "account connection\naksyon\nconnector\nconnector post\ni-publish\nintegration\nkahilingan\nkasangkapan\nmag-post\noauth\npost\npublic reply\npublish\nsocial\nsocial post\ntimeline\ntweet",
          vi: "bai dang\nbài đăng\ncong cu\ncông cụ\ndang\nđăng\ndòng thời gian\nhanh dong\nhành động\nket noi\nkết nối\nkết nối bài đăng\nmang xa hoi\nmạng xã hội\nmạng xã hội bài đăng\noauth\ntài khoản\ntich hop\ntích hợp\ntweet\nxuat ban\nxuất bản\nyeu cau\nyêu cầu",
          "zh-CN":
            "公开回复\n发布\n工具\n帖子\n授权\n推文\n操作\n时间线\n社交\n社交 帖子\n请求\n账号连接\n连接器\n连接器 帖子\n集成",
        },
      },
    },
    probePluginConfigRequirements: {
      request: {
        base: "check plugin config\ncheck_plugin_config\nconfig\nconfig keys\ndeclared\ninspect plugin requirements\ninspect_plugin_requirements\nkeys\nkeys present\nkeys which\nmissing\noptional\nplugin\nplugin declared\nplugin required\npresent\nprobe\nprobe plugin\nprobe plugin config requirements\nprobe_plugin_config_requirements\nreports\nreports plugin\nrequired\nwhich",
        locales: {
          es: "accion\nclave\ncomplemento\ncomprobar\nherramienta\nplugin\nrevisar\nrevisar plugin\nsolicitud\ntecla",
          ko: "도구\n요청\n작업\n키\n플러그인\n확인\n확인 플러그인",
          pt: "acao\nchave\nferramenta\nplugin\nsolicitacao\ntecla\nverificar\nverificar plugin",
          tl: "aksyon\nkahilingan\nkasangkapan\nkey\nplugin\nsuriin\nsuriin plugin",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nkhoa\nkhóa\nkiem tra\nkiểm tra\nkiểm tra plugin\nphim\nphím\nplugin\nyeu cau\nyêu cầu",
          "zh-CN": "密钥\n工具\n插件\n操作\n检查\n检查 插件\n请求\n键",
        },
      },
    },
    proxyStatus: {
      request: {
        base: "anthropic\nanthropic proxy status\nanthropic_proxy_status\ncheck\ncheck proxy\ncheck_proxy\nclaude max proxy status\nclaude_max_proxy_status\ndebug proxy status\nexpiry\nlistening\nlistening requests\nmode\noperations proxy status\nproxy\nproxy status\nproxy_status\nrequests\nrequests token\nstatus\nstatus mode\ntoken\ntoken expiry\nupstream\nupstream check",
        locales: {
          es: "accion\ncomprobar\nestado\nherramienta\noperacion\noperacion estado\npedir\nrevisar\nsolicitud\nsolicitud token\ntoken",
          ko: "도구\n상태\n요청\n요청 토큰\n작업\n작업 상태\n토큰\n확인",
          pt: "acao\nestado\nferramenta\noperacao\noperacao status\npedir\nsolicitacao\nsolicitacao token\nstatus\ntoken\nverificar",
          tl: "aksyon\nhiling\nkahilingan\nkahilingan token\nkasangkapan\noperasyon\noperasyon status\nstatus\nsuriin\ntoken",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nkiem tra\nkiểm tra\nthao tac\nthao tác\nthao tác trạng thái\ntoken\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu\nyêu cầu token",
          "zh-CN":
            "代币\n令牌\n工具\n操作\n操作 状态\n检查\n状态\n请求\n请求 代币",
        },
      },
    },
    read: {
      request: {
        base: "bounded\nfile\nfile numbered\nlimit\nlines\nnumbered\noffset\nread\nread text\ntext\ntext file\nwindow",
        locales: {
          es: "accion\narchivo\nherramienta\nleer\nsolicitud",
          ko: "도구\n요청\n읽기\n작업\n파일",
          pt: "acao\narquivo\nferramenta\nler\nsolicitacao",
          tl: "aksyon\nbasahin\nfile\nkahilingan\nkasangkapan",
          vi: "cong cu\ncông cụ\ndoc\nđọc\nhanh dong\nhành động\ntep\ntệp\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n文件\n请求\n读取",
        },
      },
    },
    redactTranscript: {
      request: {
        base: "anonymize transcript\nanonymize_transcript\naudio\naudio published\nclosed\ncreate\ncreate redacted transcript\ncreate refresh\ncreate_redacted_transcript\nfail\nmeeting\nonly\noriginal\npublished\nredact meeting transcript\nredact transcript\nredact_meeting_transcript\nredact_transcript\nredacted\nredaction\nrefresh\nstays\nstored\ntranscript\nunchanged\nvariant\nvariant audio\nverification",
        locales: {
          es: "accion\naudio\ncrear\nherramienta\nsolicitud",
          ko: "도구\n생성\n오디오\n요청\n작업",
          pt: "acao\naudio\ncriar\nferramenta\nsolicitacao",
          tl: "aksyon\naudio\ngumawa\nkahilingan\nkasangkapan",
          vi: "am thanh\nâm thanh\ncong cu\ncông cụ\nhanh dong\nhành động\ntao\ntạo\nyeu cau\nyêu cầu",
          "zh-CN": "创建\n工具\n操作\n请求\n音频",
        },
      },
    },
    regenerateAppApiKey: {
      request: {
        base: "app\napp key\napps regenerate app api key\nask\nask only\nasks\nasks rotate\ncloud\ncloud app\nconfirm\nconfirmation\nconfirms\neliza\nexplicit\nfinance regenerate app api key\nfirst\nfirst ask\nget\nget key\nimmediately\nintent\nintent user\ninvalidates\ninvalidates key\nkey\nkey app\nkey immediately\nkey security\nnew api key\nnew_api_key\nonly\nregenerate\nregenerate api key\nregenerate app api key\nregenerate_api_key\nregenerate_app_api_key\nrequires\nreset\nreset api key\nreset get\nreset_api_key\nrotate\nrotate app key\nrotate key\nrotate_app_key\nrotate_key\nsecurity\nsensitive\nsettings regenerate app api key\nstep\nuser\nuser asks",
        locales: {
          es: "accion\nactivar\najustes\napi clave\naplicacion\naplicacion api clave\naplicacion aplicacion api clave\naplicacion clave\napp\nclave\nclave aplicacion\nconfiguracion\nconfiguracion aplicacion api clave\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nobtener\nobtener clave\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\ntecla\nusuario\nusuario preguntar",
          ko: "api 키\n가져오기\n가져오기 키\n계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 앱 api 키\n앱\n앱 api 키\n앱 앱 api 키\n앱 키\n요청\n작업\n잔액\n질문\n청구서\n키\n키 앱\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\napi chave\naplicativo\naplicativo api chave\naplicativo aplicativo api chave\naplicativo chave\napp\nchave\nchave aplicativo\nconfiguracao\nconfiguracoes\nconfiguracoes aplicativo api chave\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nobter\nobter chave\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\ntecla\nusuario\nusuario perguntar",
          tl: "account\naksyon\napi key\napp\napp api key\napp app api key\napp key\nbalance\nconfiguration\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkey\nkey app\nkunin\nkunin key\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings app api key\ntoggle\nuser\nuser magtanong",
          vi: "api khóa\ncai dat\ncài đặt\ncài đặt ứng dụng api khóa\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nkhoa\nkhóa\nkhóa ứng dụng\nlay\nlấy\nlấy khóa\nnguoi dung\nngười dùng\nngười dùng hỏi\nphim\nphím\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng api khóa\nứng dụng khóa\nứng dụng ứng dụng api khóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "api 键\n余额\n偏好\n发票\n密钥\n工具\n应用\n应用 api 键\n应用 应用 api 键\n应用 键\n开关\n投资组合\n操作\n模型设置\n用户\n用户 询问\n获取\n获取 键\n设置\n设置 应用 api 键\n询问\n请求\n财务\n账户\n配置\n钱\n键\n键 应用",
        },
      },
    },
    reminders: {
      request: {
        base: "chat\nchat create\ncomplete\ncomplete dismiss\ncreate\ncreate list\ncreate supply\ncron\ndelivered\ndismiss\ndismiss reminder\ndismiss_reminder\nevery\nexpression\nfree\nfree reminders\ngeneral reminders\nlist\nlist reminders\nlist snooze\nlist_reminders\nminutes\nonly\nplus\nprivate\nprivate chat\nremind me\nremind_me\nreminder\nreminder text\nreminders\nreminders delivered\nreminders reminders\nschedule\nschedule minutes\nset reminder\nset_reminder\nsnooze\nsnooze complete\nsnooze reminder\nsnooze_reminder\nsupply\nsupply reminder\ntext\ntext schedule\ntimezone\nverified",
        locales: {
          es: "accion\nagendar\nchat\nchat crear\nchat general\ncompletar\nconversacion\ncrear\ncrear listar\ngeneral\ngeneral recordatorio\nhablar\nherramienta\nlistar\nlistar recordatorio\nmostrar\nprogramar\nrecordatorio\nrecordatorio recordatorio\nrespuesta\nsolicitud\nterminar",
          ko: "답변\n대화\n도구\n리마인더\n리마인더 리마인더\n말하기\n목록\n목록 리마인더\n생성\n생성 목록\n알림\n예약\n완료\n요청\n일반\n일반 대화\n일반 리마인더\n일정\n작업\n채팅\n채팅 생성",
          pt: "acao\nagendar\nchat\nchat criar\nchat geral\ncompletar\nconcluir\nconversa\ncriar\ncriar listar\nfalar\nferramenta\ngeral\ngeral lembrete\nlembrete\nlembrete lembrete\nlistar\nlistar lembrete\nmostrar\nresposta\nsolicitacao",
          tl: "aksyon\nchat\nchat gumawa\ngeneral chat\ngumawa\ngumawa ilista\ni-schedule\nilista\nilista paalala\nkahilingan\nkasangkapan\nmakipag-usap\npaalala\npaalala paalala\npangkalahatan\npangkalahatan paalala\nsagot\ntapusin\nusap",
          vi: "chung\nchung nhắc nhở\ncong cu\ncông cụ\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nlen lich\nlên lịch\nliet ke\nliệt kê\nliệt kê nhắc nhở\nnhac nho\nnhắc nhở\nnhắc nhở nhắc nhở\nnói chuyện\ntao\ntạo\ntạo liệt kê\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntrò chuyện tạo\nyeu cau\nyêu cầu",
          "zh-CN":
            "列出\n列出 提醒\n创建\n创建 列出\n回复\n回答\n安排\n完成\n对话\n工具\n提醒\n提醒 提醒\n操作\n普通聊天\n聊天\n聊天 创建\n请求\n通用\n通用 提醒",
        },
      },
    },
    resolveReferent: {
      request: {
        base: "afternoon\nask\nask book\nask disambiguating\nask usual\nasks\nasks disambiguating\nbook\nbook usual\ncalendar resolve referent\ncandidate\nclear\nclear afternoon\nconfirm\nconfirmation\nconfirmation asks\ndisambiguate referent\ndisambiguate_referent\ndisambiguating\ndoes\ndoes execute\nexecute\nexecute underlying\nexecution\nfacts\nfirst\nimplicit\ninterpretation\ninterpretation ask\nknow\nlast\nmemory resolve referent\nmessaging resolve referent\noperation\nowner\nowner ask\npreferences\npreview\nquestion\nranking\nreferents\nresolve\nresolve implicit referent\nresolve referent\nresolve_implicit_referent\nresolve_referent\nresolved\nreturns\nsame\nspecified\ntasks resolve referent\nthe usual\nthe_usual\ntime\nunder\nunderlying\nunderlying operation\nusual\nusual clear\nwhich one\nwhich_one",
        locales: {
          es: "accion\nborrar\ncalendario\nejecutar\nfecha limite\nguardar memoria\nherramienta\nlimpiar\nmemoria\noperacion\npendiente\npreguntar\npreguntar reservar\nrecordar\nrecordatorio\nrecuerdo\nreservar\nseguimiento\nsolicitud\ntarea\ntareas",
          ko: "기억\n기억해\n도구\n리마인더\n마감일\n실행\n예약\n요청\n일정\n작업\n장기 기억\n지우기\n질문\n질문 예약\n캘린더\n할 일\n회상\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\ncalendario\nexecutar\nferramenta\nlembrar\nlembrete\nlimpar\nmemoria\noperacao\nperguntar\nperguntar reservar\nprazo\nrecordar\nreservar\nsalvar memoria\nsolicitacao\ntarefa\ntarefas",
          tl: "aksyon\nalaala\nalalahanin\ndeadline\nfollow up\ngawain\nireserba\nkahilingan\nkalendaryo\nkasangkapan\nlinisin\nlong term memory\nmag-book\nmagtanong\nmagtanong mag-book\nmemory\noperasyon\npaalala\npatakbuhin\ntandaan\ntask\ntodo",
          vi: "cong cu\ncông cụ\ndat\nđặt\nghi nho\nghi nhớ\nhanh dong\nhành động\nhoi\nhỏi\nhỏi đặt\nky uc\nký ức\nlich\nlịch\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnho\nnhớ\ntac vu\ntác vụ\nthao tac\nthao tác\nthuc thi\nthực thi\nviec can lam\nviệc cần làm\nxoa\nxóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "任务\n回忆\n工具\n待办\n截止日期\n执行\n提醒\n操作\n日历\n清除\n记住\n记忆\n询问\n询问 预订\n请求\n跟进\n长期记忆\n预订",
        },
      },
    },
    retrieveChildAgentResults: {
      request: {
        base: "agent\nagent result\nagent session\nartifacts\nbundle\nchild\nchild agent\ncoding\ncoding agent\ncollect child agent output\ncollect_child_agent_output\nfetch\nfetch child agent results\nfetch_child_agent_results\nfinal\nget sub agent output\nget_sub_agent_output\nresult\nretrieve child agent results\nretrieve_child_agent_results\nsession\nstructured\ntranscript",
        locales: {
          es: "accion\nagente\nherramienta\nobtener\nobtener agente\nsolicitud",
          ko: "가져오기\n가져오기 에이전트\n도구\n에이전트\n요청\n작업",
          pt: "acao\nagente\nferramenta\nobter\nobter agente\nsolicitacao",
          tl: "agent\naksyon\nkahilingan\nkasangkapan\nkunin\nkunin agent",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nlay\nlấy\nlấy tác tử\ntac tu\ntác tử\nyeu cau\nyêu cầu",
          "zh-CN": "代理\n工具\n操作\n智能体\n获取\n获取 代理\n请求",
        },
      },
    },
    revokeOauthCredential: {
      request: {
        base: "bound\nbound oauth\ncredential\ndisconnect oauth\ndisconnect_oauth\nintent\noauth\noauth credential\npreviously\nrevoke\nrevoke oauth\nrevoke oauth credential\nrevoke_oauth\nrevoke_oauth_credential",
        locales: {
          es: "accion\nautorizacion\nherramienta\noauth\nsolicitud",
          ko: "oauth\n도구\n요청\n인증\n작업",
          pt: "acao\nautorizacao\nferramenta\noauth\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan\noauth",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\noauth\nuy quyen\nủy quyền\nyeu cau\nyêu cầu",
          "zh-CN": "oauth\n工具\n授权\n操作\n请求",
        },
      },
    },
    role: {
      request: {
        base: "admin\nadmin role\nadmin user\nassign\nassign role\nassign_role\nassignments\ndemote user\ndemote_user\nguest\nlist\nlist assignments\nlist roles\nlist_roles\nmanage\nmanage permissions\nmanage world\nmanage_permissions\nname\nowner\nowner admin\npromote user\npromote_user\nrevoke\nrevoke list\nrevoke role\nrevoke_role\nrole\nroles\nroles owner\nset role\nset_role\nsettings role\ntarget\nuser\nuser guest\nworld\nworld roles",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrador rol\nadministrador usuario\nadministrar\najustes\nconfiguracion\nconfiguracion rol\ndueño\ngestionar\nherramienta\nlistar\nlistar rol\nmodelo\nmostrar\npermisos\npolitica\npreferencias\nrol\nroles\nsolicitud\nusuario",
          ko: "관리\n관리자\n관리자 사용자\n관리자 역할\n구성\n권한\n도구\n모델 설정\n목록\n목록 역할\n사용자\n설정\n설정 역할\n소유자\n역할\n요청\n작업\n정책\n토글\n환경설정",
          pt: "acao\nadministrador\nadministrador funcao\nadministrador usuario\nalternar\nconfiguracao\nconfiguracoes\nconfiguracoes funcao\ndono\nferramenta\nfuncao\nfuncoes\ngerenciar\nlistar\nlistar funcao\nmodelo\nmostrar\npapel\npermissoes\npolitica\npreferencias\nsolicitacao\nusuario",
          tl: "admin\nadmin role\nadmin user\naksyon\nconfiguration\ngumagamit\nilista\nilista role\nkahilingan\nkasangkapan\nmay ari\nmodel settings\npahintulot\npamahalaan\npatakaran\npreferences\nrole\nsettings\nsettings role\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncài đặt vai trò\ncấu hình\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\nhanh dong\nhành động\nliet ke\nliệt kê\nliệt kê vai trò\nnguoi dung\nngười dùng\nquan ly\nquản lý\nquan tri\nquản trị\nquản trị người dùng\nquản trị vai trò\nquyen\nquyền\ntuy chon\ntùy chọn\nvai tro\nvai trò\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n列出\n列出 角色\n工具\n开关\n所有者\n操作\n权限\n模型设置\n用户\n策略\n管理\n管理员\n管理员 用户\n管理员 角色\n角色\n设置\n设置 角色\n请求\n配置",
        },
      },
    },
    rollbackFrontend: {
      request: {
        base: "again\nagain user\napp\napp frontend\napps rollback frontend\nback\nback app\ncloud\ncloud app\ndeployment\nearlier\neliza\nfrontend\nlive\nmake\nprevious\nrestore frontend version\nrestore_frontend_version\nrevert\nrevert frontend\nrevert_frontend\nroll\nroll app\nrollback frontend\nrollback_frontend\nsettings rollback frontend\nundo\nundo frontend deploy\nundo_frontend_deploy\nuser\nuser wants\nversion\nwants",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\napp\nconfiguracion\nherramienta\nmodelo\npreferencias\nsolicitud\nusuario",
          ko: "구성\n도구\n모델 설정\n사용자\n설정\n앱\n요청\n작업\n토글\n환경설정",
          pt: "acao\nalternar\naplicativo\napp\nconfiguracao\nconfiguracoes\nferramenta\nmodelo\npreferencias\nsolicitacao\nusuario",
          tl: "aksyon\napp\nconfiguration\ngumagamit\nkahilingan\nkasangkapan\nmodel settings\npreferences\nsettings\ntoggle\nuser",
          vi: "cai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nnguoi dung\nngười dùng\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "偏好\n工具\n应用\n开关\n操作\n模型设置\n用户\n设置\n请求\n配置",
        },
      },
    },
    room: {
      request: {
        base: "auto\nauto unmute\nautomatic\nautomatic unmute\nchat\nchat name\nchat platform\nchat scope\nchat thread\nchat_thread\nconnector\nconnector chat\ncontacts room\ndefault room\ndefaults\ndefaults room\nduration\nfollow\nfollow channel\nfollow chat\nfollow room\nfollow thread\nfollow unfollow\nfollow_channel\nfollow_chat\nfollow_room\nfollow_thread\nhint\njoin room\njoin_room\nleave room\nleave_room\nmessaging room\nminutes\nminutes mute\nmute\nmute auto\nmute chat\nmute discord\nmute duration\nmute room\nmute server\nmute telegram\nmute unmute\nmute_chat\nmute_discord\nmute_room\nmute_telegram\nmutes unmutes\nname\nname connector\nname room\noptional\noptional room\nplatform\nplatform chat\nreturns\nroom\nroom defaults\nroom mute\nroom platform\nroom room\nroom subscription\nroom supplied\nroom targets\nscheduling\nscope server\nserver mutes\nsettings room\nsilence group chat\nsilence_group_chat\nspecific\nspecific connector\nstate\nstate mute\nsubscription\nsupplied\nsupplied mute\ntargets\nunfollow\nunfollow chat\nunfollow default\nunfollow optional\nunfollow room\nunfollow thread\nunfollow_chat\nunfollow_room\nunfollow_thread\nunmute\nunmute chat\nunmute follow\nunmute hint\nunmute room\nunmute server\nunmute_chat\nunmute_room",
        locales: {
          es: "accion\nactivar\najustes\namigo\nchat\ncolega\nconector\nconector chat\nconfiguracion\ncontacto\ncontacto sala\ncontactos\nconversacion\ndejar de seguir\ndejar de seguir chat\ndejar de seguir sala\ngente\nherramienta\nmodelo\npersona\npreferencias\nquitar silencio\nquitar silencio chat\nquitar silencio seguir\nquitar silencio servidor\nrelacion\nsala\nsala sala\nsala servidor\nsala silenciar\nseguir\nseguir chat\nseguir dejar de seguir\nseguir sala\nservidor\nservidor silenciar\nsilenciar\nsilenciar chat\nsilenciar discord\nsilenciar quitar silencio\nsilenciar sala\nsilenciar servidor\nsilenciar telegram\nsolicitud",
          ko: "관계\n구성\n대화\n도구\n동료\n모델 설정\n방\n방 방\n방 서버\n방 음소거\n사람\n서버\n서버 음소거\n설정\n연락처\n연락처 방\n요청\n음소거\n음소거 discord\n음소거 telegram\n음소거 방\n음소거 서버\n음소거 음소거 해제\n음소거 채팅\n음소거 해제\n음소거 해제 서버\n음소거 해제 채팅\n음소거 해제 팔로우\n작업\n채팅\n채팅방\n친구\n커넥터\n커넥터 채팅\n토글\n팔로우\n팔로우 방\n팔로우 채팅\n팔로우 팔로우 해제\n팔로우 해제\n팔로우 해제 방\n팔로우 해제 채팅\n환경설정",
          pt: "acao\nalternar\namigo\nativar som\nativar som chat\nativar som seguir\nativar som servidor\nchat\ncolega\nconector\nconector chat\nconfiguracao\nconfiguracoes\ncontato\ncontato sala\ncontatos\nconversa\ndeixar de seguir\ndeixar de seguir chat\ndeixar de seguir sala\nferramenta\nmodelo\npessoa\npessoas\npreferencias\nrelacao\nsala\nsala sala\nsala servidor\nsala silenciar\nseguir\nseguir chat\nseguir deixar de seguir\nseguir sala\nservidor\nservidor silenciar\nsilenciar\nsilenciar ativar som\nsilenciar chat\nsilenciar discord\nsilenciar sala\nsilenciar servidor\nsilenciar telegram\nsolicitacao",
          tl: "aksyon\nchat\nconfiguration\nconnector\nconnector chat\ncontact\ncontact room\ncontacts\ni-mute\ni-mute chat\ni-mute discord\ni-mute i-unmute\ni-mute room\ni-mute server\ni-mute telegram\ni-unfollow\ni-unfollow chat\ni-unfollow room\ni-unmute\ni-unmute chat\ni-unmute server\ni-unmute sundan\nkahilingan\nkaibigan\nkasamahan\nkasangkapan\nkuwarto\nmodel settings\npreferences\nrelasyon\nroom\nroom i-mute\nroom room\nroom server\nserver\nserver i-mute\nsettings\nsundan\nsundan chat\nsundan i-unfollow\nsundan room\ntao\ntoggle\nusap",
          vi: "bat tieng\nbật tiếng\nbật tiếng máy chủ\nbật tiếng theo dõi\nbật tiếng trò chuyện\nbo theo doi\nbỏ theo dõi\nbỏ theo dõi phòng\nbỏ theo dõi trò chuyện\ncai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nket noi\nkết nối\nkết nối trò chuyện\nlien he\nliên hệ\nliên hệ phòng\nmay chu\nmáy chủ\nmáy chủ tắt tiếng\nphòng máy chủ\nphòng phòng\nphòng tắt tiếng\nquan he\nquan hệ\ntat tieng\ntắt tiếng\ntắt tiếng bật tiếng\ntắt tiếng discord\ntắt tiếng máy chủ\ntắt tiếng phòng\ntắt tiếng telegram\ntắt tiếng trò chuyện\ntheo doi\ntheo dõi\ntheo dõi bỏ theo dõi\ntheo dõi phòng\ntheo dõi trò chuyện\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nyêu cầu",
          "zh-CN":
            "人物\n偏好\n关注\n关注 取消关注\n关注 房间\n关注 聊天\n关系\n取消关注\n取消关注 房间\n取消关注 聊天\n取消静音\n取消静音 关注\n取消静音 服务器\n取消静音 聊天\n同事\n工具\n开关\n房间\n房间 房间\n房间 服务器\n房间 静音\n操作\n朋友\n服务器\n服务器 静音\n模型设置\n聊天\n聊天室\n联系人\n联系人 房间\n设置\n请求\n连接器\n连接器 聊天\n配置\n静音\n静音 discord\n静音 telegram\n静音 取消静音\n静音 房间\n静音 服务器\n静音 聊天",
        },
      },
    },
    runtime: {
      request: {
        base: "actions\nactions reload\nadmin runtime\nagent status runtime\nagent_internal runtime\nagent_status_runtime\napplies\navailable actions\navailable_actions\nawareness\nbounce runtime\nbounce_runtime\nbounces\ncheck self\ncheck status\ncloud\nconfig\nconnectors\nconnectors runtime\ncontrol\ncontrol status\ndescribe\ndescribe actions\ndescribe registered actions\ndescribe_registered_actions\ndetail\neliza\nfeatures\nfields\nfiltered\ngeneral runtime\nget runtime status\nget self status\nget_runtime_status\nget_self_status\nhandler\nhealth\njson\nlayer\nlist actions\nlist_actions\nlists\nmodule\nmy status\noptionally\npermissions\npermissions wallet\nplugin\npolymorphic\nprocess\nprovider\nproviders\nreboot\nreboot agent\nreboot_agent\nrefresh\nrefresh config\nrefresh_config\nregistered\nregistered actions\nregistered_actions\nreload\nreload agent\nreload config\nreload runtime\nreload runtime config\nreload_config\nreload_runtime\nreload_runtime_config\nreloadable\nrespawn\nrestart\nrestart agent\nrestart process\nrestart runtime\nrestart self\nrestart_agent\nrestart_process\nrestart_runtime\nreturns\nruntime\nruntime control\nruntime snapshot\nruntime status\nself\nself status\nservices\nsettings runtime\nsnapshots\nstatus\nstatus describe\nstatus self\nstatus snapshots\nsystem status\nwallet\nwallet runtime",
        locales: {
          es: "accion\nactivar\nadministrador\nagente\nagente estado\najustes\nbilletera\nchat general\ncomprobar\nconector\nconfiguracion\ncontrolar\ncontrolar estado\nconversacion\ncuenta conectada\ndescribir\ndescribir accion\ndireccion\ndueño\nestado\nestado describir\nestado interno\nfirmar transaccion\ngeneral\ngestion interna\nhablar\nintegracion\ninterno del agente\nlistar\nlistar accion\nmcp\nmodelo\nmostrar\noauth\nobtener\nobtener estado\npermisos\nplugin\npolitica\npreferencias\nrespuesta\nrevisar\nrevisar estado\nroles\nsaldo\nsalud\ntransferir\nwallet",
          ko: "가져오기\n가져오기 상태\n거래 서명\n건강\n계정 연결\n관리자\n구성\n권한\n내부 상태\n답변\n도구\n말하기\n모델 설정\n목록\n목록 작업\n상태\n상태 설명\n설명\n설명 작업\n설정\n소유자\n에이전트\n에이전트 내부\n에이전트 상태\n역할\n오어스\n요청\n일반\n일반 대화\n자체 관리\n작업\n잔액\n전송\n정책\n제어\n제어 상태\n주소\n지갑\n채팅\n커넥터\n토글\n통합\n포트폴리오\n플러그인\n확인\n확인 상태\n환경설정",
          pt: "acao\nadministrador\nagente\nagente status\nalternar\nassinar transacao\ncarteira\nchat geral\nconector\nconfiguracao\nconfiguracoes\nconta conectada\ncontrolar\ncontrolar status\nconversa\ndescrever\ndescrever acao\ndono\nendereco\nestado\nestado interno\nfalar\nfuncoes\ngeral\ngestao interna\nintegracao\ninterno do agente\nlistar\nlistar acao\nmcp\nmodelo\nmostrar\noauth\nobter\nobter status\npermissoes\nplugin\npolitica\npreferencias\nresposta\nsaldo\nsaude\nstatus\nstatus descrever\ntransferir\nverificar\nverificar status\nwallet",
          tl: "account connection\naddress\nadmin\nagent\nagent status\naksyon\nbalance\nconfiguration\nconnector\ngeneral chat\nilarawan\nilarawan aksyon\nilista\nilista aksyon\nintegration\ninternal ng agent\ninternal state\nkahilingan\nkalusugan\nkasangkapan\nkontrol\nkontrol status\nkunin\nkunin status\nmakipag-usap\nmay ari\nmodel settings\noauth\npahintulot\npangkalahatan\npatakaran\nplugin\npreferences\nrole\nsagot\nsariling pamamahala\nsettings\nsign transaction\nstatus\nstatus ilarawan\nsuriin\nsuriin status\ntoggle\ntransfer\nusap\nwallet",
          vi: "cai dat\ncài đặt\ncấu hình\nchu so huu\nchủ sở hữu\ndieu khien\nđiều khiển\nđiều khiển trạng thái\nhanh dong\nhành động\nket noi\nkết nối\nkiem tra\nkiểm tra\nkiểm tra trạng thái\nký giao dịch\nlấy trạng thái\nliet ke\nliệt kê\nliệt kê hành động\nmo ta\nmô tả\nmô tả hành động\nnoi bo tac tu\nnội bộ tác tử\nnói chuyện\nquan tri\nquản trị\nso du\nsố dư\nsuc khoe\nsức khỏe\ntac tu\ntác tử\ntác tử trạng thái\ntài khoản\ntich hop\ntích hợp\ntra loi\ntrả lời\ntrang thai\ntrạng thái\ntro chuyen\ntrò chuyện\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn",
          "zh-CN":
            "代理\n代理 状态\n代理内部\n余额\n偏好\n健康\n内部状态\n列出\n列出 操作\n回复\n回答\n地址\n对话\n工具\n开关\n所有者\n投资组合\n授权\n控制\n控制 状态\n描述\n描述 操作\n插件\n操作\n普通聊天\n智能体\n权限\n检查\n检查 状态\n模型设置\n状态\n状态 描述\n策略\n签名交易\n管理员\n自我管理\n获取\n获取 状态\n角色\n设置\n请求\n账号连接\n转账\n连接器\n通用\n配置\n钱包\n集成",
        },
      },
    },
    runtimes: {
      request: {
        base: "access\nadd\nadd direct\nadd private runtime\nadd_private_runtime\nadmin runtimes\napprove\nband\nbearer\nchat\nconfirm\nconfirmed\nconfirmed secrets\nconnect\nconnect add\nconnect ssh runtime\nconnect_ssh_runtime\ncreate\ndesktop\ndevice\ndevices\ndirect\nenroll\nenroll remote host\nenroll_remote_host\nevery\nfingerprint\ngeneral runtimes\nhost\nhost stop\ninspect\ninspect connect\ninspect ssh host\ninspect_ssh_host\nkeys\nlink device\nlink_device\nlist\nlist pair\nmanage\nmanage runtimes\nmanage_runtimes\nmutation\nnever\nonly\nowner\npair\npair device\npair_device\npairing\npasswords\nprivate\nprovide\nremove\nremove retry\nremove runtime\nremove_runtime\nrequires\nretry\nrevoke\nrevoke device\nrevoke remove\nrevoke_device\nruntime\nruntimes\nruntimes list\nsecrets\nsettings runtimes\nsha256\nstart\nstart remote relay\nstart_remote_relay\nstop\nstop host\nstop remote relay\nstop_remote_relay\nsystem runtimes\ntailscale\ntokens\ntrue\ntrusted\ntrusting\nverified\nwithout",
        locales: {
          es: "accion\nactivar\nadministrador\nadministrar\nagregar\najustes\nanadir\nchat\nchat general\nclave\nclave secreta\nconectar\nconectar agregar\nconfiguracion\ncontrasena\nconversacion\ncrear\ndetener\ndiagnostico\ndueño\neliminar\nescritorio\ngeneral\ngestionar\nhablar\nherramienta\nlistar\nmodelo\nmostrar\noperacion\nparar\npermisos\npolitica\npreferencias\nproceso\nquitar\nrespuesta\nroles\nruntime\nsecreto\nsistema\nsolicitud\ntecla\ntoken",
          ko: "관리\n관리자\n구성\n권한\n답변\n대화\n데스크톱\n도구\n런타임\n말하기\n모델 설정\n목록\n비밀\n비밀번호\n생성\n설정\n소유자\n시스템\n시크릿\n역할\n연결\n연결 추가\n요청\n운영 명령\n일반\n일반 대화\n작업\n정책\n제거\n중지\n진단\n채팅\n추가\n키\n토글\n토큰\n프로세스\n환경설정",
          pt: "acao\nadicionar\nadministrador\nalternar\narea de trabalho\nchat\nchat geral\nchave\nconectar\nconectar adicionar\nconfiguracao\nconfiguracoes\nconversa\ncriar\ndiagnostico\ndono\nfalar\nferramenta\nfuncoes\ngeral\ngerenciar\nlistar\nmodelo\nmostrar\noperacao\nparar\npermissoes\npolitica\npreferencias\nprocesso\nremover\nresposta\nruntime\nsegredo\nsenha\nsistema\nsolicitacao\ntecla\ntoken",
          tl: "admin\naksyon\nalisin\nchat\nconfiguration\ndesktop\ndiagnostics\ngeneral chat\ngumawa\nidagdag\nikonekta\nikonekta idagdag\nilista\nitigil\nkahilingan\nkasangkapan\nkey\nmakipag-usap\nmay ari\nmodel settings\noperation\npahintulot\npamahalaan\npangkalahatan\npassword\npatakaran\npreferences\nprocess\nrole\nruntime\nsagot\nsecret\nsettings\nsystem\ntoggle\ntoken\nusap",
          vi: "bi mat\nbí mật\ncai dat\ncài đặt\ncấu hình\nchan doan\nchẩn đoán\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ndung\ndừng\ngo\ngỡ\nhanh dong\nhành động\nhe thong\nhệ thống\nket noi\nkết nối\nkết nối thêm\nliet ke\nliệt kê\nmat khau\nmật khẩu\nmay tinh de ban\nmáy tính để bàn\nnói chuyện\nquan ly\nquản lý\nquan tri\nquản trị\nquyen\nquyền\nruntime\ntao\ntạo\nthem\nthêm\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "代币\n令牌\n偏好\n停止\n列出\n创建\n回复\n回答\n密码\n密钥\n对话\n工具\n开关\n所有者\n操作\n普通聊天\n权限\n桌面\n模型设置\n添加\n秘密\n移除\n策略\n管理\n管理员\n系统\n聊天\n角色\n设置\n诊断\n请求\n运维命令\n运行时\n进程\n连接\n连接 添加\n通用\n配置\n键",
        },
      },
    },
    scheduledTasks: {
      request: {
        base: "acknowledge\nadd follow up\nadmin\nadmin owner\napproval\nasks\nautomation scheduled tasks\ncalendar scheduled tasks\ncancel\nchat\ncheckin\ncomplete\ncomplete follow up\ncreate\ncustom\ndate\ndays since\ndeadlines\ndismiss\nevent set decision deadline\nevent track asset deadlines\nexplicit\nflow\nfollow up list\nfollowup\nfollowups scheduled tasks\nget\ngoal\ngoals\ngoals create\ngoals owner\nhabit\nhabits\nhabits goals\nhistory\nincluding\nitem\nitem admin\nkinds\nlevel\nlife\nlist\nlist overdue followups\nmark followup done\nnotification acknowledge\nnotification create intent\nnotification escalate\noutput\nover\nowner\nowner goals\nowner reminders\nproductivity scheduled tasks\nrecap\nrecords\nreminder\nreminder task\nreminder_task\nreminders\nreminders deadlines\nreminders owner\nreminders scheduled tasks\nreopen\nrequires\nroutine\nroutines\nsaving\nscheduled\nscheduled followup\nscheduled reminder\nscheduled task\nscheduled tasks\nscheduled_followup\nscheduled_reminder\nscheduled_task\nscheduled_tasks\nschedules\nset followup threshold\nskip\nsnooze\nstructural\nsurface\ntask\ntask acknowledge\ntask complete\ntask dismiss\ntask snooze\ntask_acknowledge\ntask_complete\ntask_dismiss\ntask_snooze\ntasks scheduled tasks\ntrigger\nupdate\nuser\nwatcher",
        locales: {
          es: "accion\nactualizar\nadministrador\nagendar\nagregar\nagregar seguir\nanadir\nautomatizacion\nautomatizacion tarea\ncalendario\ncalendario tarea\nchat\ncompletar\ncompletar seguir\nconversacion\ncrear\ncron\ndisparador\nfecha limite\nflujo de trabajo\nherramienta\nhistorial\nlistar\nmeta\nmeta crear\nmonitor\nmostrar\nobjetivo\nobtener\npendiente\nplan de trabajo\nplanificacion\npreguntar\nprioridades\nproductividad\nprogramar\nrecordatorio\nrecordatorio tarea\nseguimiento\nseguir\nseguir listar\nsolicitud\ntarea\ntarea completar\ntareas\nterminar\nusuario",
          ko: "가져오기\n계획\n관리자\n기록\n대화\n도구\n리마인더\n리마인더 작업\n마감일\n모니터\n목록\n목표\n목표 생성\n사용자\n생산성\n생성\n알림\n업데이트\n업무 계획\n예약\n완료\n완료 팔로우\n요청\n우선순위\n워크플로\n일정\n자동화\n자동화 작업\n작업\n작업 완료\n질문\n채팅\n추가\n추가 팔로우\n캘린더\n캘린더 작업\n크론\n트리거\n팔로우\n팔로우 목록\n할 일\n후속 조치",
          pt: "acao\nacompanhamento\nadicionar\nadicionar seguir\nadministrador\nafazer\nagendar\natualizar\nautomacao\nautomacao tarefa\ncalendario\ncalendario tarefa\nchat\ncompletar\nconcluir\nconcluir seguir\nconversa\ncriar\ncron\nferramenta\nfluxo de trabalho\ngatilho\nhistorico\nlembrete\nlembrete tarefa\nlistar\nmeta\nmeta criar\nmonitor\nmostrar\nobjetivo\nobter\nperguntar\nplanejamento\nplano de trabalho\nprazo\nprioridades\nprodutividade\nseguir\nseguir listar\nsolicitacao\ntarefa\ntarefa concluir\ntarefas\nusuario",
          tl: "admin\naksyon\nautomation\nautomation gawain\nchat\ncron\ndeadline\nfollow up\ngawain\ngawain tapusin\ngumagamit\ngumawa\nhistory\ni-schedule\ni-update\nidagdag\nidagdag sundan\nilista\nkahilingan\nkalendaryo\nkalendaryo gawain\nkasangkapan\nkunin\nlayunin\nlayunin gumawa\nmagtanong\nmonitor\npaalala\npaalala gawain\npagpaplano\nprayoridad\nproductivity\nsundan\nsundan ilista\ntapusin\ntapusin sundan\ntask\ntodo\ntrigger\nusap\nuser\nwork plan\nworkflow",
          vi: "cap nhat\ncập nhật\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nhoàn thành theo dõi\nkich hoat\nlap ke hoach\nlập kế hoạch\nlen lich\nlên lịch\nlịch nhiệm vụ\nlich su\nlịch sử\nliet ke\nliệt kê\nmuc tieu\nmục tiêu\nmục tiêu tạo\nnang suat\nnăng suất\nnguoi dung\nngười dùng\nnhac nho\nnhắc nhở\nnhắc nhở nhiệm vụ\nnhiem vu\nnhiệm vụ\nnhiệm vụ hoàn thành\nquan tri\nquản trị\nquy trinh\nquy trình\ntac vu\ntác vụ\nthêm theo dõi\ntheo doi\ntheo dõi\ntheo dõi liệt kê\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntự động hóa nhiệm vụ\nưu tiên\nviec can lam\nviệc cần làm",
          "zh-CN":
            "任务\n任务 完成\n优先级\n关注\n关注 列出\n列出\n创建\n历史\n安排\n完成\n完成 关注\n定时\n工作流\n工作计划\n工具\n待办\n截止日期\n提醒\n提醒 任务\n操作\n效率\n日历\n日历 任务\n更新\n添加\n添加 关注\n用户\n监控\n目标\n目标 创建\n管理员\n聊天\n自动化\n自动化 任务\n获取\n规划\n触发器\n询问\n请求\n跟进",
        },
      },
    },
    searchChannelTopics: {
      request: {
        base: "channel\nchannels\nfind channels by topic\nfind_channels_by_topic\nmost\nquery\nrecent\nrelevant\nrelevant query\nreturn\nrooms\nrooms return\nsearch\nsearch channel topics\nsearch recent\nsearch topics\nsearch_channel_topics\nsearch_topics\ntopic search\ntopic_search\ntopics\ntopics rooms",
        locales: {
          es: "accion\nbuscar\nchat\nconsulta\nencontrar\nherramienta\nsala\nsolicitud",
          ko: "검색\n도구\n방\n요청\n작업\n질의\n찾기\n채팅방\n쿼리",
          pt: "acao\nbuscar\nchat\nconsulta\nencontrar\nferramenta\nsala\nsolicitacao",
          tl: "aksyon\nhanapin\nkahilingan\nkasangkapan\nkuwarto\nmaghanap\nquery\nroom",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nphong\nphòng\ntim\ntìm\ntim kiem\ntìm kiếm\ntruy van\ntruy vấn\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n房间\n搜索\n操作\n查找\n查询\n聊天室\n请求",
        },
      },
    },
    searchKnowledge: {
      request: {
        base: "added\nagent_internal search knowledge\nattach\nattachments\nattachments free\ncallers\nchat\ndocuments\ndocuments search knowledge\ndocuments transcripts\nfacet\nfacet search\nfacets\nfacets room\nfiles search knowledge\nfind document\nfind knowledge\nfind_document\nfind_knowledge\nfollow\nformat\nformats\nfree\ningested\ningested attachments\nitems\nknowledge\nknowledge documents\nknowledge returns\nknowledge search knowledge\nlookup knowledge\nlookup_knowledge\nmatching\nmedia\nmedia search knowledge\nmultimedia\nmultimedia knowledge\nnever\noptional\nover\nover knowledge\nowner\nplus\nprivate\nreturns\nroom\nroom sender\nscope\nsearch\nsearch docs\nsearch files\nsearch knowledge\nsearch multimedia\nsearch over\nsearch transcripts\nsearch_docs\nsearch_files\nsearch_knowledge\nsearch_transcripts\nsemantic\nsend\nsender\nsurface\ntags\ntext\ntheir\ntitles\ntranscripts\nwalled",
        locales: {
          es: "accion\nadjunto\nagente\nagente buscar conocimiento\narchivo\narchivo buscar conocimiento\narchivos\naudio\nbuscar\nbuscar archivo\nbuscar conocimiento\nbuscar documento\ncaptura\ncarpeta\nchat\nconocimiento\nconocimiento buscar conocimiento\nconocimiento documento\nconversacion\ndirectorio\ndocumento\ndocumento buscar conocimiento\ndocumentos\nencontrar\nenviar\nestado interno\ngestion interna\nguardar notas\nhechos guardados\nherramienta\nimagen\ninterno del agente\nleer archivo\nmultimedia\nmultimedia buscar conocimiento\nnotas\nnotas guardadas\nrecordar\nsala\nseguir\nsolicitud\ntranscripcion\nvideo",
          ko: "검색\n검색 지식\n검색 파일\n내부 상태\n노트\n대화\n도구\n디렉터리\n문서\n문서 검색 지식\n미디어\n미디어 검색 지식\n방\n보내기\n비디오\n스크린샷\n에이전트\n에이전트 검색 지식\n에이전트 내부\n오디오\n요청\n이미지\n자체 관리\n작업\n저장\n저장된 노트\n저장된 사실\n전사\n지식\n지식 검색 지식\n지식 문서\n찾기\n찾기 문서\n찾기 지식\n채팅\n채팅방\n첨부파일\n파일\n파일 검색 지식\n파일 내용\n파일 쓰기\n파일 읽기\n팔로우\n폴더\n회상",
          pt: "acao\nagente\nagente buscar conhecimento\nanexo\narquivo\narquivo buscar conhecimento\narquivos\naudio\nbuscar\nbuscar arquivo\nbuscar conhecimento\ncaptura\nchat\nconhecimento\nconhecimento buscar conhecimento\nconhecimento documento\nconversa\ndiretorio\ndocumento\ndocumento buscar conhecimento\ndocumentos\nencontrar\nencontrar conhecimento\nencontrar documento\nenviar\nestado interno\nfatos salvos\nferramenta\ngestao interna\nimagem\ninterno do agente\nlembrar\nler arquivo\nmidia\nmidia buscar conhecimento\nnotas\nnotas salvas\npasta\nsala\nsalvar notas\nseguir\nsolicitacao\ntranscricao\nvideo",
          tl: "agent\nagent maghanap kaalaman\naksyon\nalalahanin\nattachment\naudio\nbasahin file\nchat\ndirectory\ndokumento\ndokumento maghanap kaalaman\nfile\nfile maghanap kaalaman\nfiles\nfolder\nhanapin\nhanapin dokumento\nhanapin kaalaman\ni-save\ninternal ng agent\ninternal state\nipadala\nkaalaman\nkaalaman dokumento\nkaalaman maghanap kaalaman\nkahilingan\nkasangkapan\nkuwarto\nlarawan\nmaghanap\nmaghanap file\nmaghanap kaalaman\nmedia\nmedia maghanap kaalaman\nnilalaman ng file\nnotes\nroom\nsariling pamamahala\nsaved facts\nsaved notes\nscreenshot\nsundan\ntranscript\nusap\nvideo",
          vi: "âm thanh\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nđa phương tiện tìm kiếm kiến thức\ndoc tep\nđọc tệp\nghi chu\nghi chú\nghi chu da luu\nghi chú đã lưu\nhanh dong\nhành động\nhinh anh\nhình ảnh\nkien thuc\nkiến thức\nkiến thức tài liệu\nkiến thức tìm kiếm kiến thức\nlưu ghi chú\nnhớ lại\nnoi bo tac tu\nnội bộ tác tử\ntac tu\ntác tử\ntác tử tìm kiếm kiến thức\ntai lieu\ntài liệu\ntài liệu tìm kiếm kiến thức\ntep dinh kem\ntệp đính kèm\ntệp tìm kiếm kiến thức\ntheo doi\ntheo dõi\nthu muc\nthư mục\ntim kiem\ntìm kiếm\ntìm kiếm kiến thức\ntìm kiếm tệp\ntìm kiến thức\ntìm tài liệu\ntro chuyen\ntrò chuyện\ntu quan ly\ntự quản lý\nyêu cầu",
          "zh-CN":
            "代理\n代理 搜索 知识\n代理内部\n保存笔记\n关注\n内部状态\n写文件\n发送\n回忆\n图片\n媒体\n媒体 搜索 知识\n工具\n已保存事实\n已保存笔记\n截图\n房间\n搜索\n搜索 文件\n搜索 知识\n操作\n文件\n文件 搜索 知识\n文件内容\n文件夹\n文档\n文档 搜索 知识\n智能体\n查找\n查找 文档\n查找 知识\n目录\n知识\n知识 搜索 知识\n知识 文档\n视频\n笔记\n聊天\n聊天室\n自我管理\n语义搜索\n请求\n读取文件\n转录\n附件\n音频",
        },
      },
    },
    secrets: {
      request: {
        base: "ask for secret\nask_for_secret\ncheck\ncheck mirror\nconfigure secret\nconfigure_secret\nconnectors secrets\ncopy secret to vault\ncopy_secret_to_vault\ndelete\ndelete list\nenumerate secrets\nenumerate_secrets\nerase secret\nerase_secret\nfetch secret\nfetch_secret\nget\nget delete\nhandle secret\nhandle_secret\nhas secret\nhas_secret\nlist\nlist check\nmanage\nmanage secrets\nmirror\nmissing\nmissing secret\nmissing_secret\nneed secret\nneed_secret\npurge secret\npurge_secret\nread secret\nread_secret\nremove secret\nremove_secret\nrequest\nrequest missing\nrequire secret\nrequire_secret\nretrieve secret\nretrieve_secret\nsave secret\nsave_secret\nsecret\nsecret exists\nsecret management\nsecret operation\nsecret_exists\nsecret_management\nsecret_operation\nsecrets\nsecrets get\nsecrets secrets\nset api key\nset_api_key\nsettings secrets\nshow secrets\nshow_secrets\nstore secret\nstore_secret\nvault\nvault mirror secret\nvault request\nvault_mirror_secret\nverify secret\nverify_secret",
        locales: {
          es: "activar\najustes\napi clave\nborrar\nclave\nclave api\nclave secreta\ncomprobar\nconector\nconector secreto\nconfiguracion\nconfiguracion secreto\nconfigurar\nconfigurar secreto\ncontraseña\ncredencial\ncuenta conectada\neliminar\neliminar listar\neliminar secreto\ngestion\ngestionar secreto\nintegracion\nleer\nleer secreto\nlistar revisar\nmanejar\nmanejar secreto\nmcp\nmodelo\noauth\nobtener eliminar\noperacion\npreferencias\npreguntar\npreguntar secreto\nquitar\nrevisar\nsecreto\nsecreto gestion\nsecreto obtener\nsecreto operacion\nsecreto secreto\nsecretos\ntecla\ntienda\ntienda secreto\ntoken",
          ko: "api 키\n가져오기\n가져오기 삭제\n계정 연결\n관리\n관리 비밀\n구성\n도구\n모델 설정\n목록\n목록 확인\n비밀\n비밀 가져오기\n비밀 관리\n비밀 비밀\n비밀 작업\n비밀번호\n삭제\n삭제 목록\n상점\n상점 비밀\n설정\n설정 비밀\n스토어\n시크릿\n오어스\n요청\n읽기\n읽기 비밀\n자격 증명\n작업\n제거\n제거 비밀\n질문\n질문 비밀\n처리\n처리 비밀\n커넥터\n커넥터 비밀\n키\n토글\n토큰\n통합\n확인\n환경설정",
          pt: "alternar\napagar\napi chave\nchave\nchave api\nconector\nconector segredo\nconfiguracao\nconfiguracoes\nconfiguracoes segredo\nconfigurar\nconfigurar segredo\nconta conectada\ncredencial\nexcluir\nexcluir listar\ngerenciamento\ngerenciar segredo\nintegracao\nler\nler segredo\nlidar\nlidar segredo\nlistar\nlistar verificar\nloja\nloja segredo\nmcp\nmodelo\nmostrar\noauth\nobter excluir\noperacao\nperguntar\nperguntar segredo\npreferencias\nremover\nremover segredo\nsegredo\nsegredo gerenciamento\nsegredo obter\nsegredo operacao\nsegredo segredo\nsegredos\nsenha\ntecla\ntoken\nverificar",
          tl: "account connection\naksyon\nalisin\nalisin secret\napi key\nbasahin\nbasahin secret\nburahin\nburahin ilista\nconfiguration\nconnector\nconnector secret\ncredential\nhawakan\nhawakan secret\nhiling\ni-configure\ni-configure secret\nilista\nilista suriin\nintegration\nkahilingan\nkasangkapan\nkey\nkunin\nkunin burahin\nmagtanong\nmagtanong secret\nmodel settings\noauth\noperasyon\npamahalaan\npamahalaan secret\npamamahala\npassword\npreferences\nsecret\nsecret kunin\nsecret operasyon\nsecret pamamahala\nsecret secret\nsettings\nsettings secret\nsuriin\ntindahan\ntindahan secret\ntoggle\ntoken",
          vi: "api khóa\nbi mat\nbí mật\nbí mật bí mật\nbí mật lấy\nbí mật quản lý\nbí mật thao tác\ncai dat\ncài đặt\ncài đặt bí mật\ncau hinh\ncấu hình\ncấu hình bí mật\ncua hang\ncửa hàng\ncửa hàng bí mật\nđọc bí mật\ngỡ bí mật\nhành động\nhỏi bí mật\nket noi\nkết nối\nkết nối bí mật\nkhoa api\nkhóa api\nkiem tra\nkiểm tra\nlấy xóa\nliet ke\nliệt kê\nliệt kê kiểm tra\nmật khẩu\nquan ly\nquản lý\nquản lý bí mật\ntài khoản\nthao tac\nthao tác\ntich hop\ntích hợp\ntuy chon\ntùy chọn\nxóa liệt kê\nxu ly\nxử lý\nxử lý bí mật\nyeu cau\nyêu cầu",
          "zh-CN":
            "API 密钥\napi 键\n令牌\n偏好\n凭据\n列出\n列出 检查\n删除\n删除 列出\n商店\n商店 密钥\n处理\n处理 密钥\n密码\n密钥\n密钥 密钥\n密钥 操作\n密钥 管理\n密钥 获取\n工具\n开关\n授权\n操作\n检查\n模型设置\n秘密\n移除\n移除 密钥\n管理\n管理 密钥\n获取\n获取 删除\n设置\n设置 密钥\n询问\n询问 密钥\n请求\n读取\n读取 密钥\n账号连接\n连接器\n连接器 密钥\n配置\n配置 密钥\n键\n集成",
        },
      },
    },
    secretsUpdateSettings: {
      request: {
        base: "admin\nconfiguration\nconfigure\nconnectors secrets update settings\nduring\nfirst-run\nowner\nowner admin\nprocess\nsave setting\nsave_setting\nsaves\nsecrets secrets update settings\nsecrets update settings\nsecrets_update_settings\nset configuration\nset_configuration\nsetting\nsettings secrets update settings\nsetup\nupdate setting\nupdate_setting\nworld",
        locales: {
          es: "accion\nactivar\nactualizar\nadministrador\najustes\nclave api\nclave secreta\nconector\nconector secreto actualizar configuracion\nconfiguracion\nconfiguracion secreto actualizar configuracion\nconfigurar\ncontraseña\ncredencial\ncuenta conectada\nejecutar\nherramienta\nintegracion\nmcp\nmodelo\noauth\npreferencias\nsecreto\nsecreto actualizar configuracion\nsecreto secreto actualizar configuracion\nsecretos\nsolicitud\ntoken",
          ko: "api 키\n계정 연결\n관리자\n구성\n도구\n모델 설정\n비밀\n비밀 비밀 업데이트 설정\n비밀 업데이트 설정\n비밀번호\n설정\n설정 비밀 업데이트 설정\n시크릿\n실행\n업데이트\n오어스\n요청\n자격 증명\n작업\n커넥터\n커넥터 비밀 업데이트 설정\n토글\n토큰\n통합\n환경설정",
          pt: "acao\nadministrador\nalternar\natualizar\nchave api\nconector\nconector segredo atualizar configuracoes\nconfiguracao\nconfiguracoes\nconfiguracoes segredo atualizar configuracoes\nconfigurar\nconta conectada\ncredencial\nexecutar\nferramenta\nintegracao\nmcp\nmodelo\noauth\npreferencias\nsegredo\nsegredo atualizar configuracoes\nsegredo segredo atualizar configuracoes\nsegredos\nsenha\nsolicitacao\ntoken",
          tl: "account connection\nadmin\naksyon\napi key\nconfiguration\nconnector\nconnector secret i-update settings\ncredential\ni-configure\ni-update\nintegration\nkahilingan\nkasangkapan\nmodel settings\noauth\npassword\npatakbuhin\npreferences\nsecret\nsecret i-update settings\nsecret secret i-update settings\nsettings\nsettings secret i-update settings\ntoggle\ntoken",
          vi: "bi mat\nbí mật\nbí mật bí mật cập nhật cài đặt\nbí mật cập nhật cài đặt\ncai dat\ncài đặt\ncài đặt bí mật cập nhật cài đặt\ncap nhat\ncập nhật\ncau hinh\ncấu hình\nchay\nchạy\ncong cu\ncông cụ\nhanh dong\nhành động\nket noi\nkết nối\nkết nối bí mật cập nhật cài đặt\nkhoa api\nkhóa api\nmật khẩu\noauth\nquan tri\nquản trị\ntài khoản\ntich hop\ntích hợp\ntoken\ntuy chon\ntùy chọn\nyeu cau\nyêu cầu",
          "zh-CN":
            "API 密钥\n令牌\n偏好\n凭据\n密码\n密钥\n密钥 密钥 更新 设置\n密钥 更新 设置\n工具\n开关\n授权\n操作\n更新\n模型设置\n秘密\n管理员\n设置\n设置 密钥 更新 设置\n请求\n账号连接\n运行\n连接器\n连接器 密钥 更新 设置\n配置\n集成",
        },
      },
    },
    securityEvaluator: {
      request: {
        base: "security evaluator\nsecurity_evaluator\nsecurityevaluator",
        locales: {
          es: "accion\nherramienta\nsolicitud",
          ko: "도구\n요청\n작업",
          pt: "acao\nferramenta\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n请求",
        },
      },
    },
    sendMediaTo: {
      request: {
        base: "agent_internal send media to\nconnector\nconnector dispatch\ndispatch\ndm media\ndm_media\ndocuments send media to\nenforces\nenforces send\nfiles send media to\nitem\nitem media\nknowledge\nknowledge item\nknowledge send media to\nmedia\nmedia room\nmedia send media to\nmedia target\noutcome\nowner\nprivate\nprivate user\npublic\npublic room\nrefused\nreturns\nroom\nroom enforces\nroom returns\nroom scope\nroom through\nscope\nsend\nsend file to\nsend knowledge\nsend media to\nsend stored\nsend wall\nsend_file_to\nsend_knowledge\nsend_media_to\nsha256\nshare media\nshare_media\nstored\nstored knowledge\ntakes\ntarget\ntarget room\nthrough\nthrough connector\ntyped\nuser\nuser private\nwall\nwalled",
        locales: {
          es: "accion\nagente\nagente enviar multimedia\narchivo\narchivo enviar multimedia\narchivos\naudio\ncaptura\ncarpeta\nchat\nconector\nconocimiento\nconocimiento enviar multimedia\ndirectorio\ndocumento\ndocumento enviar multimedia\ndocumentos\nenviar\nenviar archivo\nenviar conocimiento\nenviar multimedia\nestado interno\ngestion interna\nguardar notas\nhechos guardados\nherramienta\nimagen\ninterno del agente\nleer archivo\nmultimedia\nmultimedia enviar multimedia\nmultimedia sala\nnotas\nnotas guardadas\nrecordar\nsala\nsolicitud\ntranscripcion\nusuario\nvideo",
          ko: "검색\n내부 상태\n노트\n도구\n디렉터리\n문서\n문서 보내기 미디어\n미디어\n미디어 방\n미디어 보내기 미디어\n방\n보내기\n보내기 미디어\n보내기 지식\n보내기 파일\n비디오\n사용자\n스크린샷\n에이전트\n에이전트 내부\n에이전트 보내기 미디어\n오디오\n요청\n이미지\n자체 관리\n작업\n저장\n저장된 노트\n저장된 사실\n전사\n지식\n지식 보내기 미디어\n채팅방\n커넥터\n파일\n파일 내용\n파일 보내기 미디어\n파일 쓰기\n파일 읽기\n폴더\n회상",
          pt: "acao\nagente\nagente enviar midia\narquivo\narquivo enviar midia\narquivos\naudio\ncaptura\nchat\nconector\nconhecimento\nconhecimento enviar midia\ndiretorio\ndocumento\ndocumento enviar midia\ndocumentos\nenviar\nenviar arquivo\nenviar conhecimento\nenviar midia\nestado interno\nfatos salvos\nferramenta\ngestao interna\nimagem\ninterno do agente\nlembrar\nler arquivo\nmidia\nmidia enviar midia\nmidia sala\nnotas\nnotas salvas\npasta\nsala\nsalvar notas\nsolicitacao\ntranscricao\nusuario\nvideo",
          tl: "agent\nagent ipadala media\naksyon\nalalahanin\naudio\nbasahin file\nconnector\ndirectory\ndokumento\ndokumento ipadala media\nfile\nfile ipadala media\nfiles\nfolder\ngumagamit\ni-save\ninternal ng agent\ninternal state\nipadala\nipadala file\nipadala kaalaman\nipadala media\nkaalaman\nkaalaman ipadala media\nkahilingan\nkasangkapan\nkuwarto\nlarawan\nmedia\nmedia ipadala media\nmedia room\nnilalaman ng file\nnotes\nroom\nsariling pamamahala\nsaved facts\nsaved notes\nscreenshot\ntranscript\nuser\nvideo",
          vi: "âm thanh\ncong cu\ncông cụ\nda phuong tien\nđa phương tiện\nđa phương tiện gửi đa phương tiện\nđa phương tiện phòng\ndoc tep\nđọc tệp\nghi chu\nghi chú\nghi chu da luu\nghi chú đã lưu\ngửi\ngửi đa phương tiện\ngửi kiến thức\ngửi tệp\nhanh dong\nhành động\nhinh anh\nhình ảnh\nket noi\nkết nối\nkien thuc\nkiến thức\nkiến thức gửi đa phương tiện\nlưu ghi chú\nnguoi dung\nngười dùng\nnhớ lại\nnoi bo tac tu\nnội bộ tác tử\ntac tu\ntác tử\ntác tử gửi đa phương tiện\ntai lieu\ntài liệu\ntài liệu gửi đa phương tiện\ntep\ntệp\ntệp gửi đa phương tiện\nthu muc\nthư mục\ntu quan ly\ntự quản lý\nvideo\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 发送 媒体\n代理内部\n保存笔记\n内部状态\n写文件\n发送\n发送 媒体\n发送 文件\n发送 知识\n回忆\n图片\n媒体\n媒体 发送 媒体\n媒体 房间\n工具\n已保存事实\n已保存笔记\n截图\n房间\n操作\n文件\n文件 发送 媒体\n文件内容\n文件夹\n文档\n文档 发送 媒体\n智能体\n用户\n目录\n知识\n知识 发送 媒体\n视频\n笔记\n聊天室\n自我管理\n语义搜索\n请求\n读取文件\n转录\n连接器\n音频",
        },
      },
    },
    setAdCampaignDayparting: {
      request: {
        base: "advertising\napps set ad campaign dayparting\ncampaign\ncloud\ndayparting\ndelivery\ndelivery schedule\nfinance set ad campaign dayparting\nparameters\nrequires\nschedule\nschedule ad campaign\nschedule requires\nschedule_ad_campaign\nset ad campaign dayparting\nset ad delivery windows\nset_ad_campaign_dayparting\nset_ad_delivery_windows\nsettings set ad campaign dayparting\nstructured\ntimezone\nupdate ad dayparting\nupdate_ad_dayparting\nwindows",
        locales: {
          es: "accion\nactivar\nactualizar\nagendar\najustes\naplicacion\napp\nconfiguracion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\nprogramar\nsaldo\nsolicitud",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n설정\n앱\n업데이트\n예약\n요청\n일정\n작업\n잔액\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nagendar\nalternar\naplicativo\napp\natualizar\nconfiguracao\nconfiguracoes\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nportfolio\npreferencias\nsaldo\nsolicitacao",
          tl: "account\naksyon\napp\nbalance\nconfiguration\nfinance\ni-schedule\ni-update\ninvoice\nkahilingan\nkasangkapan\nmodel settings\npera\nportfolio\npreferences\nsettings\ntoggle",
          vi: "cai dat\ncài đặt\ncap nhat\ncập nhật\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nlen lich\nlên lịch\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n安排\n工具\n应用\n开关\n投资组合\n操作\n更新\n模型设置\n设置\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    setCompanionMood: {
      request: {
        base: "companion\nconfirms\ndevice\ndisplayed\nmood\nparameter\nrejects\nrequires\nset companion mood\nset_companion_mood",
        locales: {
          es: "accion\nherramienta\nsolicitud",
          ko: "도구\n요청\n작업",
          pt: "acao\nferramenta\nsolicitacao",
          tl: "aksyon\nkahilingan\nkasangkapan",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n请求",
        },
      },
    },
    setFollowupThreshold: {
      request: {
        base: "calendar set followup threshold\nchange followup interval\nchange_followup_interval\ncontacts set followup threshold\nfollowup create rule\nfollowup rule\nfollowup_create_rule\nfollowup_rule\nset contact frequency days\nset followup threshold\nset_contact_frequency_days\nset_followup_threshold\nsettings set followup threshold\ntasks set followup threshold",
        locales: {
          es: "accion\nactivar\najustes\namigo\ncalendario\ncolega\nconfiguracion\ncontacto\ncontactos\ncrear\ncrear regla\nfecha limite\ngente\nherramienta\nmodelo\npendiente\npersona\npreferencias\nrecordatorio\nregla\nrelacion\nseguimiento\nsolicitud\ntarea\ntareas",
          ko: "관계\n구성\n규칙\n도구\n동료\n리마인더\n마감일\n모델 설정\n사람\n생성\n생성 규칙\n설정\n연락처\n요청\n일정\n작업\n친구\n캘린더\n토글\n할 일\n환경설정\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\nalternar\namigo\ncalendario\ncolega\nconfiguracao\nconfiguracoes\ncontato\ncontatos\ncriar\ncriar regra\nferramenta\nlembrete\nmodelo\npessoa\npessoas\nprazo\npreferencias\nregra\nrelacao\nsolicitacao\ntarefa\ntarefas",
          tl: "aksyon\nconfiguration\ncontact\ncontacts\ndeadline\nfollow up\ngawain\ngumawa\ngumawa panuntunan\nkahilingan\nkaibigan\nkalendaryo\nkasamahan\nkasangkapan\nmodel settings\npaalala\npanuntunan\npreferences\nrelasyon\nsettings\ntao\ntask\ntodo\ntoggle",
          vi: "cai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nlich\nlịch\nlien he\nliên hệ\nnguoi\nngười\nnhắc nhở\nnhiem vu\nnhiệm vụ\nquan he\nquan hệ\nquy tac\nquy tắc\ntac vu\ntác vụ\ntao\ntạo\ntạo quy tắc\ntuy chon\ntùy chọn\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "人物\n任务\n偏好\n关系\n创建\n创建 规则\n同事\n工具\n开关\n待办\n截止日期\n提醒\n操作\n日历\n朋友\n模型设置\n联系人\n规则\n设置\n请求\n跟进\n配置",
        },
      },
    },
    settings: {
      request: {
        base: "admin settings\nagent internal settings\napp permission\napp permissions\napply update\nask for camera\nask for microphone\nauto training\nautomatic training\nbackup agent\nchange accent\nchange permission\nchange permissions\nchange setting\nchange theme mode\nchange ui language\nchange update channel\nchange wallet rpc\ncheck for updates\nconfigure auto\ncreate agent backup\ndisable auto training\ndisable shell\ndisable shell access\ndispatch update\neliza cloud rpc\nenable auto training\nenable shell\nenable shell access\nfilesystem access\ngeneral settings\nget setting\ngrant app access\ngrant app permission\ngrant filesystem access\ngrant network access\ngrant permission\ngrant shell access\nhome time widget\nlist settings\nname write\nnetwork access\npolymorphic settings\nremember name\nrequest os permission\nrequest permission\nrestore agent backup\nrevoke app access\nrevoke app permission\nrevoke filesystem access\nrevoke network access\nrevoke permission\nrevoke shell access\nroute backend\nsave name\nset accent\nset backend\nset brain backend\nset coding backend\nset name\nset owner name\nset permission\nset theme mode\nset ui language\nset user name\nset wallet rpc\nsettings mutation\nsettings registry\nsettings settings\nsettings write\nshell access\nshell permission\nshell permissions\nshow backends\nsystem settings\ntoggle auto training\ntoggle capability\ntoggle configure\ntoggle permission\ntoggle setting\ntoggle shell access\nturn off shell\nturn off shell access\nupdate ai provider\nupdate owner name\nupdate provider\nupdate settings\nupdate status\nvoice continuous chat\nvoice end of turn\nvoice settings\nvoice vad settings\nwallet rpc\nwallet rpc provider\nworld settings\nwrite world",
        locales: {
          es: "accion obtener\nactivar\nactualizar\nactualizar configuracion\nactualizar estado\nadministrador\nadministrador configuracion\nagente\nagente configuracion\najustes\naplicacion\napp\nchat general\nconfiguracion\nconfiguracion accion\nconfiguracion escribir\nconfiguracion obtener\nconfiguracion operacion\nconversacion\ncrear\ncrear agente\ndesactivar\ndiagnostico\ndueño\nejecutar configuracion\nescribir\nestado interno\ngeneral configuracion\ngestion interna\nhablar\ninterno del agente\nlistar\nlistar configuracion\nmodelo\nmostrar\nobtener\nobtener listar\noperacion\npermisos\npolitica\npreferencias\nproceso\nrespuesta\nrevisar actualizar\nroles\nruntime\nsistema\nusuario",
          ko: "가져오기\n가져오기 목록\n관리자\n관리자 설정\n구성\n권한\n내부 상태\n답변\n런타임\n말하기\n모델 설정\n목록\n목록 설정\n비활성화\n사용자\n생성\n생성 에이전트\n설정\n설정 가져오기\n설정 쓰기\n설정 작업\n소유자\n시스템\n실행 설정\n쓰기\n앱\n업데이트\n업데이트 상태\n업데이트 설정\n에이전트\n에이전트 내부\n에이전트 설정\n역할\n요청\n운영 명령\n일반 대화\n일반 설정\n자체 관리\n작업 가져오기\n정책\n진단\n질문\n채팅\n토글\n프로세스\n확인 업데이트\n환경설정\n활성화",
          pt: "acao obter\nadministrador\nadministrador configuracoes\nagente\nagente configuracoes\nalternar\naplicativo\nativar\natualizar\natualizar configuracoes\natualizar status\nchat geral\nconfiguracao\nconfiguracoes\nconfiguracoes acao\nconfiguracoes escrever\nconfiguracoes obter\nconfiguracoes operacao\nconversa\ncriar\ncriar agente\ndesativar\ndiagnostico\ndono\nescrever\nestado interno\nexecutar configuracoes\nfalar\nfuncoes\ngeral configuracoes\ngestao interna\ninterno do agente\nlistar\nlistar configuracoes\nmodelo\nmostrar\nobter\nobter listar\noperacao\npermissoes\npolitica\npreferencias\nprocesso\nresposta\nruntime\nsistema\nusuario\nverificar atualizar",
          tl: "admin\nadmin settings\nagent\nagent settings\naksyon kunin\napp\nconfiguration\ndiagnostics\ngeneral chat\ngumagamit\ngumawa\ngumawa agent\ni-disable\ni-enable\ni-update\ni-update settings\ni-update status\nilista\nilista settings\ninternal ng agent\ninternal state\nisulat\nkunin\nkunin ilista\nmakipag-usap\nmay ari\nmodel settings\noperation\npahintulot\npangkalahatan settings\npatakaran\npatakbuhin settings\npreferences\nprocess\nrole\nruntime\nsagot\nsariling pamamahala\nsettings\nsettings aksyon\nsettings isulat\nsettings kunin\nsettings operasyon\nsuriin i-update\nsystem\ntoggle\nusap\nuser",
          vi: "cai dat\ncài đặt\ncài đặt viết\ncap nhat\ncập nhật\ncập nhật cài đặt\ncập nhật trạng thái\ncau hinh\ncấu hình\nchan doan\nchẩn đoán\nchu so huu\nchủ sở hữu\nchung cài đặt\nhe thong\nhệ thống\nkiem tra\nkiểm tra\nkiểm tra cập nhật\nliet ke\nliệt kê\nliệt kê cài đặt\nnguoi dung\nngười dùng\nnoi bo tac tu\nnội bộ tác tử\nnói chuyện\nquan tri\nquản trị\nquản trị cài đặt\ntac tu\ntác tử\ntác tử cài đặt\ntạo tác tử\ntra loi\ntrả lời\ntrang thai\ntrạng thái\ntro chuyen\ntrò chuyện\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 设置\n代理内部\n偏好\n内部状态\n写入\n列出\n列出 设置\n创建\n创建 代理\n启用\n回复\n回答\n对话\n应用\n开关\n所有者\n操作 获取\n普通聊天\n智能体\n更新\n更新 状态\n更新 设置\n权限\n检查 更新\n模型设置\n用户\n禁用\n策略\n管理员\n管理员 设置\n系统\n自我管理\n获取\n获取 列出\n角色\n设置\n设置 写入\n设置 操作\n设置 获取\n诊断\n请求\n运维命令\n运行 设置\n运行时\n进程\n通用 设置\n配置",
        },
      },
    },
    shareTranscript: {
      request: {
        base: "admin\nadmin redact\ncontent\ncontent admin\ndisclose transcript\ndisclose_transcript\nentity\nevery\nfull\ngrant transcript access\ngrant_transcript_access\ngrants\nparticipant\npersisted\npersisted room\nredact\nredacted\nredacted content\nroom\nroom grants\nroom roster\nroster\nshare\nshare meeting transcript\nshare transcript\nshare_meeting_transcript\nshare_transcript\nsnapshot\nsnapshots\nsnapshots room\nstored\ntranscript\nvariant",
        locales: {
          es: "accion\nadministrador\nchat\ncontenido\ncontenido administrador\nherramienta\nsala\nsolicitud",
          ko: "관리자\n내용\n도구\n방\n요청\n작업\n채팅방\n콘텐츠\n콘텐츠 관리자",
          pt: "acao\nadministrador\nchat\nconteudo\nconteudo administrador\nferramenta\nsala\nsolicitacao",
          tl: "admin\naksyon\nkahilingan\nkasangkapan\nkuwarto\nnilalaman\nnilalaman admin\nroom",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nnoi dung\nnội dung\nnội dung quản trị\nphong\nphòng\nquan tri\nquản trị\nyeu cau\nyêu cầu",
          "zh-CN": "内容\n内容 管理员\n工具\n房间\n操作\n管理员\n聊天室\n请求",
        },
      },
    },
    shell: {
      request: {
        base: "accepted\nartifacts\nautomation shell\nbackground\nbash\nbounded\nbounded commands\nclear\nclear shell\nclear view\ncode shell\ncommand\ncommands\ncommands complete\ncommands default\ncommands manage\ncommands page\ncommands start\ncomplete\ncomplete accepted\nconversation\ndefault\neach\nenvironment\nevery\nexact\nexec\nforeground\nfresh\nhistory\nhistory bounded\nkill\nkill list\nlegacy\nlist\nlist background\nmanage\nmanage conversation\nmoved\noutput\npage\npage output\npoll\npoll write\nprefix\nredacted\nrequired\nretrieve\nrun\nrun command\nrun shell\nrun_command\nscoped\nsession\nsessions\nsessions clear\nshell\nshell commands\nshell history\nstart\nstarts\nsupplied\nterminal shell\nunexpired\nunless\nunless user\nuser\nuser supplied\nvariables\nview\nview clear\nview history\nwrite\nwrite kill",
        locales: {
          es: "accion\nadministrar\nautomatizacion\nbash\nborrar\ncodigo\ncomando\ncomando completar\ncomando gestionar\ncomando pagina\ncompletar\ncron\ndepurar\ndisparador\nejecutar\nejecutar comando\nescribir\nflujo de trabajo\ngestionar\nherramienta\nhistorial\nimplementar\nlimpiar\nlinea de comandos\nlistar\nmonitor\nmostrar\npagina\nproceso\nprogramacion\nprueba\nrepositorio\nshell\nsolicitud\nterminal\nterminar\nusuario",
          ko: "관리\n구현\n기록\n도구\n디버그\n명령\n명령 관리\n명령 완료\n명령 페이지\n명령줄\n모니터\n목록\n배시\n사용자\n셸\n실행\n실행 명령\n쓰기\n완료\n요청\n워크플로\n자동화\n작업\n저장소\n지우기\n코드\n크론\n터미널\n테스트\n트리거\n페이지\n프로그래밍\n프로세스",
          pt: "acao\nautomacao\nbash\ncodigo\ncomando\ncomando concluir\ncomando gerenciar\ncomando pagina\ncompletar\nconcluir\ncron\ndepurar\nescrever\nexecutar\nexecutar comando\nferramenta\nfluxo de trabalho\ngatilho\ngerenciar\nhistorico\nimplementar\nlimpar\nlinha de comando\nlistar\nmonitor\nmostrar\npagina\nprocesso\nprogramacao\nrepositorio\nshell\nsolicitacao\nterminal\nteste\nusuario",
          tl: "aksyon\nautomation\nbash\ncode\ncommand\ncommand line\ncommand pahina\ncommand pamahalaan\ncommand tapusin\ncron\ndebug\ngumagamit\nhistory\nilista\nipatupad\nisulat\nkahilingan\nkasangkapan\nlinisin\nmonitor\npahina\npamahalaan\npatakbuhin\npatakbuhin command\nprocess\nprogramming\nrepo\nshell\ntapusin\nterminal\ntest\ntrigger\nuser\nworkflow",
          vi: "bash\nchay\nchạy\nchạy lệnh\ncong cu\ncông cụ\ndong lenh\ndòng lệnh\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nlenh\nlệnh\nlệnh hoàn thành\nlệnh quản lý\nlệnh trang\nlich su\nlịch sử\nliet ke\nliệt kê\nma\nmã\nnguoi dung\nngười dùng\nquan ly\nquản lý\nquy trinh\nquy trình\nshell\nterminal\ntiến trình\ntrang\ntu dong hoa\ntự động hóa\nviet\nviết\nxoa\nxóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "Bash\n仓库\n代码\n写入\n列出\n历史\n命令\n命令 完成\n命令 管理\n命令 页面\n命令行\n完成\n定时\n实现\n工作流\n工具\n操作\n标准输出\n测试\n清除\n用户\n监控\n管理\n终端\n编程\n自动化\n触发器\n请求\n调试\n运行\n运行 命令\n进程\n页面",
        },
      },
    },
    showElizaOmarchyPill: {
      request: {
        base: "asks\nasks show\nchat\nchat pill\neliza\nexplicit\nexplicit request\nexplicitly\nexplicitly asks\nlocal\nomarchy\nonly\nonly user\nopen\nopen eliza\nopen local\npill\nquick\nquick chat\nrequest\nshow\nshow eliza omarchy pill\nshow open\nshow_eliza_omarchy_pill\nuser\nuser explicitly",
        locales: {
          es: "abrir\naccion\nchat\nconversacion\nherramienta\npedir\npreguntar\nsolicitud\nusuario",
          ko: "대화\n도구\n사용자\n열기\n요청\n작업\n질문\n채팅",
          pt: "abrir\nacao\nchat\nconversa\nferramenta\npedir\nperguntar\nsolicitacao\nusuario",
          tl: "aksyon\nbuksan\nchat\ngumagamit\nhiling\nkahilingan\nkasangkapan\nmagtanong\nusap\nuser",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nmo\nmở\nnguoi dung\nngười dùng\ntro chuyen\ntrò chuyện\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n打开\n操作\n用户\n聊天\n询问\n请求",
        },
      },
    },
    showOmarchyNotification: {
      request: {
        base: "alert\nasks\nasks notification\nattach\nattach click\nbody\nclick\nclick command\ncommand\ndesktop\ndesktop alert\ndesktop notification\ndoes\nexplicitly\nexplicitly asks\nheadline\nlocal\nnotification\nnotification desktop\nomarchy\nomarchy desktop\nonly\nonly user\nrequested\nrequires\nshow\nshow omarchy notification\nshow_omarchy_notification\nuser\nuser explicitly",
        locales: {
          es: "accion\nclic\nclic comando\ncomando\nescritorio\nhacer clic\nherramienta\npreguntar\nsolicitud\nusuario",
          ko: "데스크톱\n도구\n명령\n사용자\n요청\n작업\n질문\n클릭\n클릭 명령",
          pt: "acao\narea de trabalho\nclicar\nclicar comando\ncomando\nferramenta\nperguntar\nsolicitacao\nusuario",
          tl: "aksyon\nclick\nclick command\ncommand\ndesktop\ngumagamit\nkahilingan\nkasangkapan\nmagtanong\nuser",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nlenh\nlệnh\nmay tinh de ban\nmáy tính để bàn\nnguoi dung\nngười dùng\nnhap\nnhấp\nnhấp lệnh\nyeu cau\nyêu cầu",
          "zh-CN": "命令\n工具\n操作\n桌面\n点击\n点击 命令\n用户\n询问\n请求",
        },
      },
    },
    skill: {
      request: {
        base: "action\naction chips\nactivation\nautomation skill\navailable\navailable skills\nbefore\nbrowse\nbrowse skills\nbundled\nbundled skill\ncatalog\ncatalog operations\ncatalog search\ncategory\nchips\nchips enable\nclaw\nconnectors skill\ncopy\ncopy details\ndetailed\ndetails\ndetails info\ndetails sync\ndisable\ndisable install\ndisable installed\ndisable skill\ndiscover skills\neach\nenable\nenable disable\nenable skill\nenabled\nfind skills\nget\nget detailed\nget skill\nincluding\ninfo\ninformation\ninstall\ninstall copy\ninstall install\ninstall registry\ninstall skill\ninstall uninstall\ninstalled\ninstalled skill\ninstead\ninvoking\nkeyword\nknowledge skill\nlist skills\nmanage\nmanage skill\noperations\noperations search\nowner\nrefresh\nregistry\nremove\nremove bundled\nresult\nresult action\nreturns\nreturns action\nscanned\nsearch\nsearch browse\nsearch details\nsearch skill\nsecurity\nsettings skill\nskill\nskill catalog\nskill claw\nskill details\nskill disable\nskill enable\nskill including\nskill info\nskill install\nskill registry\nskill sync\nskill version\nskills\nskills details\nskills keyword\nspecific\nspecific skill\nstats\nsync skill\ntoggle enable\ntoggle install",
        locales: {
          es: "activar\nactivar desactivar\nactivar habilidad\nactualizar habilidad\nagente habilidad\nagregar habilidad\najustes\nautomatizacion\nautomatizacion habilidad\nbuscar detalles\nbuscar habilidad\nconector\nconector habilidad\nconfiguracion\nconocimiento\nconocimiento habilidad\ncron\ncuenta conectada\ndesactivar habilidad\ndesactivar instalar\ndescargar habilidad\ndescribir\ndescribir habilidad\ndetalles\ndisparador\neliminar habilidad\nflujo de trabajo\ngestionar habilidad\nhabilidad\nhabilidad buscar\nhabilidad detalles\nhechos guardados\ninstalar habilidad\ninstalar instalar\nintegracion\nlistar habilidad\nmcp\nmodelo\nmonitor\nnotas guardadas\noauth\nobtener\nobtener habilidad\nobtener habilidad detalles\noperacion buscar\npreferencias\nrecordar\nskill",
          ko: "가져오기 스킬\n가져오기 스킬 세부정보\n검색\n검색 세부정보\n검색 스킬\n계정 연결\n관리 스킬\n구성\n다운로드 스킬\n모니터\n모델 설정\n목록 스킬\n비활성화 설치\n비활성화 스킬\n삭제 스킬\n설명\n설명 스킬\n설정\n설치 설치\n설치 스킬\n세부정보\n스킬\n스킬 검색\n스킬 세부정보\n업데이트 스킬\n에이전트 스킬\n오어스\n워크플로\n자동화\n자동화 스킬\n작업 검색\n저장된 노트\n저장된 사실\n제거 스킬\n지식\n지식 스킬\n찾기 스킬\n추가 스킬\n커넥터\n커넥터 스킬\n크론\n토글\n통합\n트리거\n환경설정\n활성화 비활성화\n활성화 스킬\n회상",
          pt: "adicionar habilidade\nagente habilidade\nalternar\nativar desativar\nativar habilidade\natualizar habilidade\nautomacao\nautomacao habilidade\nbaixar habilidade\nbuscar detalhes\nbuscar habilidade\nconector\nconector habilidade\nconfiguracao\nconfiguracoes\nconhecimento\nconhecimento habilidade\nconta conectada\ncron\ndesativar habilidade\ndesativar instalar\ndescrever habilidade\ndetalhes\nencontrar habilidade\nexcluir habilidade\nfatos salvos\nfluxo de trabalho\ngatilho\ngerenciar habilidade\nhabilidade\nhabilidade buscar\nhabilidade detalhes\ninstalar habilidade\ninstalar instalar\nintegracao\nlembrar\nlistar habilidade\nmcp\nmodelo\nmonitor\nnotas salvas\noauth\nobter habilidade\nobter habilidade detalhes\noperacao buscar\npreferencias\nremover habilidade\nskill",
          tl: "account connection\nagent skill\nalalahanin\nalisin skill\nautomation\nautomation skill\nburahin skill\nconfiguration\nconnector\nconnector skill\ncron\ndetalye\nhanapin skill\ni-disable i-install\ni-disable skill\ni-download skill\ni-enable i-disable\ni-enable skill\ni-install i-install\ni-install skill\ni-update skill\nidagdag skill\nilarawan\nilarawan skill\nilista skill\nintegration\nkaalaman\nkaalaman skill\nkasanayan\nkunin skill\nkunin skill detalye\nmaghanap detalye\nmaghanap skill\nmodel settings\nmonitor\noauth\noperasyon maghanap\npamahalaan skill\npreferences\nsaved facts\nsaved notes\nsettings\nskill\nskill detalye\nskill maghanap\ntoggle\ntrigger\nworkflow",
          vi: "cai dat\ncài đặt\ncài đặt kỹ năng\ncấu hình\nchi tiet\nchi tiết\nghi chu da luu\nghi chú đã lưu\nket noi\nkết nối\nkich hoat\nkien thuc\nkiến thức\nky nang\nkỹ năng\nkỹ năng chi tiết\nkỹ năng tìm kiếm\nlấy kỹ năng\nlấy kỹ năng chi tiết\nliet ke\nliệt kê\nliệt kê kỹ năng\nmo ta\nmô tả\nmô tả kỹ năng\nnhớ lại\nquan ly\nquản lý\nquản lý kỹ năng\nquy trinh\nquy trình\ntác tử\ntác tử kỹ năng\ntài khoản\ntai xuong\ntải xuống\ntải xuống kỹ năng\nthêm kỹ năng\ntich hop\ntích hợp\ntim kiem\ntìm kiếm\ntìm kiếm kỹ năng\ntìm kỹ năng\ntu dong hoa\ntự động hóa\ntuy chon\ntùy chọn",
          "zh-CN":
            "下载 技能\n代理 技能\n偏好\n列出 技能\n删除 技能\n启用 技能\n启用 禁用\n回忆\n安装 安装\n安装 技能\n定时\n工作流\n已保存事实\n已保存笔记\n开关\n技能\n技能 搜索\n技能 详情\n授权\n描述\n描述 技能\n搜索 技能\n搜索 详情\n操作 搜索\n更新 技能\n查找 技能\n模型设置\n添加 技能\n监控\n知识\n知识 技能\n禁用 安装\n禁用 技能\n移除 技能\n管理 技能\n自动化\n自动化 技能\n获取 技能\n获取 技能 详情\n触发器\n设置\n详情\n语义搜索\n账号连接\n连接器\n连接器 技能\n配置\n集成",
        },
      },
    },
    spotify: {
      request: {
        base: "between\ncontrol\ncontrol playback\ncontrol spotify\ncreate\ncreate extend\ndevices\nextend\nhand\ninspect\ninspect control\nlibrary\nlibrary list\nlist\nlist create\nmanage\nmanage saved\nmusic\nmusic manage\nplay music\nplay_music\nplayback\nplaylists\nsaved\nsearch\nsearch music\nspotify\nspotify control\nspotify search\nspotify_control\ntrack",
        locales: {
          es: "accion\nadministrar\nbuscar\nbuscar musica\ncontrolar\ncrear\ngestionar\nherramienta\nlistar\nlistar crear\nmostrar\nmusica\nmusica gestionar\nreproducir\nreproducir musica\nsolicitud\ntocar",
          ko: "검색\n검색 음악\n관리\n도구\n목록\n목록 생성\n생성\n요청\n음악\n음악 관리\n작업\n재생\n재생 음악\n제어",
          pt: "acao\nbuscar\nbuscar musica\ncontrolar\ncriar\nferramenta\ngerenciar\nlistar\nlistar criar\nmostrar\nmusica\nmusica gerenciar\nreproduzir\nsolicitacao\ntocar\ntocar musica",
          tl: "aksyon\ngumawa\nilista\nilista gumawa\nkahilingan\nkasangkapan\nkontrol\nmaghanap\nmaghanap musika\nmusika\nmusika pamahalaan\npamahalaan\npatugtugin\npatugtugin musika",
          vi: "cong cu\ncông cụ\ndieu khien\nđiều khiển\nhanh dong\nhành động\nliet ke\nliệt kê\nliệt kê tạo\nnhac\nnhạc\nnhạc quản lý\nphat\nphát\nphát nhạc\nquan ly\nquản lý\ntao\ntạo\ntim kiem\ntìm kiếm\ntìm kiếm nhạc\nyeu cau\nyêu cầu",
          "zh-CN":
            "列出\n列出 创建\n创建\n工具\n控制\n搜索\n搜索 音乐\n播放\n播放 音乐\n操作\n管理\n请求\n音乐\n音乐 管理",
        },
      },
    },
    startTranscription: {
      request: {
        base: "asks\nasks start\nbegin transcription\nbegin_transcription\nconversation\ndevice\ndevice user\nform\nlong\nmeeting\nonly\nonly user\nrecord\nrecord transcript\nrecord_transcript\nrecording\nstart\nstart recording\nstart transcription\nstart_recording\nstart_transcription\ntranscribing\ntranscription\nuser\nuser asks\nuser device\nvoice",
        locales: {
          es: "accion\nherramienta\npreguntar\nsolicitud\nusuario\nusuario preguntar",
          ko: "도구\n사용자\n사용자 질문\n요청\n작업\n질문",
          pt: "acao\nferramenta\nperguntar\nsolicitacao\nusuario\nusuario perguntar",
          tl: "aksyon\ngumagamit\nkahilingan\nkasangkapan\nmagtanong\nuser\nuser magtanong",
          vi: "cong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nnguoi dung\nngười dùng\nngười dùng hỏi\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n操作\n用户\n用户 询问\n询问\n请求",
        },
      },
    },
    stopTranscription: {
      request: {
        base: "currently\ndevice\nend transcription\nend_transcription\nfinish transcript\nfinish_transcript\nform\nlong\nrunning\nrunning user\nstop\nstop long\nstop recording\nstop transcription\nstop_recording\nstop_transcription\ntranscription\nuser\nuser device\nvoice",
        locales: {
          es: "accion\ndetener\nfinalizar\nherramienta\nparar\nsolicitud\nusuario",
          ko: "도구\n사용자\n완료\n요청\n작업\n중지",
          pt: "acao\nferramenta\nfinalizar\nparar\nsolicitacao\nusuario",
          tl: "aksyon\ngumagamit\nitigil\nkahilingan\nkasangkapan\ntapusin\nuser",
          vi: "cong cu\ncông cụ\ndung\ndừng\nhanh dong\nhành động\nket thuc\nkết thúc\nnguoi dung\nngười dùng\nyeu cau\nyêu cầu",
          "zh-CN": "停止\n工具\n操作\n用户\n结束\n请求",
        },
      },
    },
    submitPressRelease: {
      request: {
        base: "apps submit press release\nbacked\nbefore\ncalling\ncloud\nconfirm\nconfirmation\ndistribute press release\ndistribute_press_release\ndistribution\nexplicit\nfinance submit press release\npaid\npress\nprovider\nrelease\nrequires\nroute\nsend press release\nsend_press_release\nsettings submit press release\nsubmit\nsubmit pr\nsubmit press release\nsubmit_pr\nsubmit_press_release",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\napp\nconfiguracion\ncuenta\ndinero\nenviar\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\nsaldo\nsolicitud",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n보내기\n설정\n앱\n요청\n작업\n잔액\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\napp\nconfiguracao\nconfiguracoes\nconta\ndinheiro\nenviar\nfatura\nferramenta\nfinancas\nmodelo\nportfolio\npreferencias\nsaldo\nsolicitacao",
          tl: "account\naksyon\napp\nbalance\nconfiguration\nfinance\ninvoice\nipadala\nkahilingan\nkasangkapan\nmodel settings\npera\nportfolio\npreferences\nsettings\ntoggle",
          vi: "cai dat\ncài đặt\ncấu hình\ncong cu\ncông cụ\ngui\ngửi\nhanh dong\nhành động\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n发送\n工具\n应用\n开关\n投资组合\n操作\n模型设置\n设置\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    tasks: {
      request: {
        base: "abort task\narchive coding task\narchive task\narchive task thread\nautomation tasks\ncan i see it\ncancel agent\ncancel task\ncancel task agent\nclone repo\nclose coding task\nclose issue\ncode tasks\ncode this\ncomment issue\ncommit and pr\ncontinue task\ncontrol task\ncount tasks\ncreate agent\ncreate agent task\ncreate coding agent\ncreate issue\ncreate pr\ncreate subtask\ncreate task\ncreate workspace\nend coding session\nfinalize workspace\nfinish workspace\nget active agents\nget issue\nget task history\ninput to agent\nkill coding agent\nkill task\nlaunch coding agent\nlaunch coding task\nlaunch task\nlist agents\nlist coding agents\nlist issues\nlist sessions\nlist sub agents\nlist task history\nmanage issues\nmessage agent\nmessage coding agent\npause task\nprepare workspace\nprovision workspace\npull it up\nreopen coding task\nreopen task\nrespond to agent\nresume coding task\nresume task\nrun coding agent\nrun coding task\nsend to agent\nsend to coding agent\nsetup workspace\nshare task result\nshow coding agents\nshow coding sessions\nshow task agents\nshow task artifact\nshow task status\nshow tasks\nspawn agent\nspawn and provision\nspawn coder\nspawn coding agent\nspawn sub agent\nstart agent task\nstart coding agent\nstart coding task\nstart task agent\nstop agent\nstop coding agent\nstop sub agent\nstop subtask\nstop task\nsubmit changes\nsubmit workspace\ntask control\ntask history\ntask share\ntask status history\ntasks tasks\ntell coding agent\ntell task agent\nterminate agent\nunarchive coding task\nupdate issue\nview task output",
        locales: {
          es: "actualizar github incidencia\nactualizar incidencia\nagente tarea\narchivar tarea\ncodigo tarea\ncomentario incidencia\ncontrolar tarea\ncrear agente\ncrear agente tarea\ncrear espacio de trabajo\ncrear github incidencia\ncrear incidencia\ncrear pr\ncrear tarea\ncuenta conectada\ndetener agente\ndetener tarea\nejecutar agente\nejecutar tarea\nenviar agente\nespacio de trabajo\nestado interno\nfinalizar espacio de trabajo\nflujo de trabajo\ngestion interna\ngestionar incidencia\ngithub actualizar incidencia\ngithub agregar comentario\ngithub comentario incidencia\ngithub crear incidencia\ngithub incidencia\ngithub listar incidencia\ngithub obtener incidencia\ninterno del agente\nlistar agente\nlistar github incidencia\nlistar incidencia\nlistar tarea historial\nmensaje agente\nobtener activo agente\nobtener github incidencia\nobtener incidencia\nobtener tarea historial\ntarea agente\ntarea controlar\ntarea estado\ntarea estado historial\ntarea historial",
          ko: "github 가져오기 이슈\ngithub 댓글 이슈\ngithub 목록 이슈\ngithub 생성 이슈\ngithub 업데이트 이슈\ngithub 이슈\ngithub 추가\ngithub 추가 댓글\n가져오기 github 이슈\n가져오기 이슈\n가져오기 작업 기록\n가져오기 활성 에이전트\n계정 연결\n관리 이슈\n내부 상태\n댓글 이슈\n메시지 에이전트\n목록 github 이슈\n목록 에이전트\n목록 이슈\n목록 작업 기록\n보관 작업\n보내기 에이전트\n생성 github 이슈\n생성 pr\n생성 에이전트\n생성 에이전트 작업\n생성 이슈\n생성 작업\n생성 작업공간\n실행 에이전트\n실행 작업\n업데이트 github 이슈\n업데이트 이슈\n에이전트 내부\n에이전트 작업\n완료 작업공간\n자체 관리\n작업 기록\n작업 상태\n작업 상태 기록\n작업 에이전트\n작업 제어\n제어 작업\n중지 에이전트\n중지 작업\n추가 댓글\n코드 작업",
          pt: "agente tarefa\narquivar tarefa\natualizar github problema\natualizar problema\ncodigo tarefa\ncomentario problema\nconta conectada\ncontrolar tarefa\ncriar agente\ncriar agente tarefa\ncriar github problema\ncriar pr\ncriar problema\ncriar tarefa\ncriar workspace\nenviar agente\nespaco de trabalho\nestado interno\nexecutar agente\nexecutar tarefa\nfinalizar workspace\nfluxo de trabalho\ngerenciar problema\ngestao interna\ngithub adicionar comentario\ngithub atualizar problema\ngithub comentario problema\ngithub criar problema\ngithub listar problema\ngithub obter problema\ngithub problema\ninterno do agente\nlistar agente\nlistar github problema\nlistar problema\nlistar tarefa historico\nmensagem agente\nobter ativo agente\nobter github problema\nobter problema\nobter tarefa historico\nparar agente\nparar tarefa\ntarefa agente\ntarefa controlar\ntarefa historico\ntarefa status\ntarefa status historico",
          tl: "account connection\nagent gawain\ncode gawain\ngawain agent\ngawain history\ngawain kontrol\ngawain status\ngawain status history\ngithub gumawa isyu\ngithub i-update isyu\ngithub idagdag\ngithub idagdag komento\ngithub ilista isyu\ngithub isyu\ngithub komento isyu\ngithub kunin isyu\ngumawa agent\ngumawa agent gawain\ngumawa gawain\ngumawa github isyu\ngumawa isyu\ngumawa pr\ngumawa workspace\ni-archive gawain\ni-update github isyu\ni-update isyu\nidagdag komento\nilista agent\nilista gawain history\nilista github isyu\nilista isyu\ninternal ng agent\ninternal state\nipadala agent\nitigil agent\nitigil gawain\nkomento isyu\nkontrol gawain\nkunin aktibo agent\nkunin gawain history\nkunin github isyu\nkunin isyu\nmensahe agent\npamahalaan isyu\npatakbuhin agent\npatakbuhin gawain\nsariling pamamahala\ntapusin workspace",
          vi: "chạy nhiệm vụ\nchạy tác tử\ndang hoat dong\nđang hoạt động\ndừng nhiệm vụ\ndừng tác tử\ngửi tác tử\nket noi\nkết nối\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nlấy đang hoạt động tác tử\nlịch sử\nliet ke\nliệt kê\nliệt kê tác tử\nmã nhiệm vụ\nnhiem vu\nnhiệm vụ\nnhiệm vụ lịch sử\nnhiệm vụ tác tử\nnhiệm vụ trạng thái\nnoi bo tac tu\nnội bộ tác tử\nquy trinh\nquy trình\ntac tu\ntác tử\ntác tử nhiệm vụ\ntài khoản\ntạo nhiệm vụ\ntạo tác tử\ntạo tác tử nhiệm vụ\ntich hop\ntích hợp\ntin nhan\ntin nhắn\ntin nhắn tác tử\ntrang thai\ntrạng thái\ntu dong hoa\ntự động hóa\ntu quan ly\ntự quản lý",
          "zh-CN":
            "github 列出 问题\ngithub 创建 问题\ngithub 更新 问题\ngithub 添加\ngithub 添加 评论\ngithub 获取 问题\ngithub 评论 问题\ngithub 问题\n代理 任务\n代码 任务\n任务 代理\n任务 历史\n任务 控制\n任务 状态\n任务 状态 历史\n停止 代理\n停止 任务\n列出 github 问题\n列出 代理\n列出 任务 历史\n列出 历史\n列出 问题\n创建 github 问题\n创建 pr\n创建 代理\n创建 代理 任务\n创建 任务\n创建 工作区\n创建 问题\n发送 代理\n发送 控制\n归档 任务\n控制 任务\n控制 列出\n更新 github 问题\n更新 问题\n消息 代理\n添加 评论\n管理 问题\n结束 工作区\n自动化 任务\n获取 github 问题\n获取 任务 历史\n获取 活跃 代理\n获取 问题\n评论 问题\n运行 代理\n运行 任务",
        },
      },
    },
    todo: {
      request: {
        base: "actions write\nagent internal todo\nagent_internal todo\nautomation todo\ncancel\ncancel delete\ncancel todo\ncancel_todo\nclear\nclear todos\nclear user\nclear_todos\ncomplete\ncomplete cancel\ncomplete list\ncomplete todo\ncomplete_todo\ncreate\ncreate complete\ncreate todo\ncreate update\ncreate_todo\ndelete\ndelete list\ndelete todo\ndelete_todo\nedit\nedit delete\nentity\nfinish todo\nfinish_todo\nget todos\nget_todos\nlist\nlist actions\nlist clear\nlist edit\nlist requests\nlist todos\nlist write\nlist_todos\nmanage\nmanage list\nmanage user\noperation\nremove todo\nremove_todo\nreplace list\nrequests\nrequests user\nroute\nroute todo\nscoped\nset todos\nset_todos\nshow todos\nshow_todos\ntask\ntasks\ntasks todo\ntodo\ntodo cancel\ntodo clear\ntodo complete\ntodo create\ntodo delete\ntodo list\ntodo manage\ntodo operation\ntodo update\ntodo write\ntodo_cancel\ntodo_clear\ntodo_complete\ntodo_create\ntodo_delete\ntodo_list\ntodo_update\ntodo_write\ntodos\ntodos todo\nupdate\nupdate complete\nupdate todo\nupdate todos\nupdate_todo\nupdate_todos\nuser\nuser create\nuser scoped\nuser todo\nwrite\nwrite create\nwrite replace\nwrite todos\nwrite_todos",
        locales: {
          es: "accion escribir\nactualizar completar\nactualizar todo\nagente todo\nagregar actualizar\nautomatizacion todo\nborrar tarea\ncompletar listar\ncompletar tarea\ncompletar todo\ncontenido estado\ncrear actualizar\ncrear agregar\ncrear completar\ncrear todo\neditar eliminar\neliminar listar\neliminar todo\nescribir crear\nescribir todo\nestado activo\nfecha limite\nfinalizar todo\nflujo de trabajo\ngestionar listar\ngestionar usuario\nlimpiar todo\nlimpiar usuario\nlista de tareas\nlistar accion\nlistar editar\nlistar escribir\nlistar limpiar\nlistar solicitud\nlistar todo\nobtener todo\nsolicitud usuario\ntarea\ntarea todo\ntodo actualizar\ntodo completar\ntodo contenido\ntodo crear\ntodo eliminar\ntodo escribir\ntodo limpiar\ntodo listar\nusuario todo",
          ko: "가져오기 할일\n관리 목록\n관리 사용자\n목록 쓰기\n목록 요청\n목록 작업\n목록 지우기\n목록 편집\n목록 할일\n사용자 할일\n삭제 목록\n삭제 할일\n상태 활성\n생성 업데이트\n생성 완료\n생성 추가\n생성 할일\n쓰기 생성\n쓰기 할일\n업데이트 완료\n업데이트 할일\n에이전트 할일\n완료 목록\n완료 할일\n요청 사용자\n자동화 할일\n작업 목록\n작업 삭제\n작업 쓰기\n작업 완료\n작업 할일\n제거 할일\n지우기 사용자\n지우기 할일\n추가 업데이트\n콘텐츠 상태\n편집 삭제\n할 일\n할일 목록\n할일 삭제\n할일 생성\n할일 쓰기\n할일 업데이트\n할일 완료\n할일 지우기\n할일 콘텐츠\n활성 작업\n후속 조치",
          pt: "acao escrever\nadicionar atualizar\nagente todo\napagar tarefa\natualizar concluir\natualizar todo\nautomacao todo\nconcluir listar\nconcluir tarefa\nconcluir todo\nconteudo status\ncriar adicionar\ncriar atualizar\ncriar concluir\ncriar todo\neditar excluir\nescrever criar\nescrever todo\nexcluir listar\nexcluir todo\nfinalizar todo\nfluxo de trabalho\ngerenciar listar\ngerenciar usuario\nlimpar todo\nlimpar usuario\nlista de tarefas\nlistar acao\nlistar editar\nlistar escrever\nlistar limpar\nlistar solicitacao\nlistar todo\nobter todo\nremover todo\nsolicitacao usuario\nstatus ativo\ntarefa\ntarefa todo\ntodo atualizar\ntodo concluir\ntodo conteudo\ntodo criar\ntodo escrever\ntodo excluir\ntodo limpar\ntodo listar\nusuario todo",
          tl: "agent todo\naksyon isulat\nalisin todo\nautomation todo\nburahin ilista\nburahin task\nburahin todo\nfollow up\ngawain todo\ngumawa i-update\ngumawa idagdag\ngumawa tapusin\ngumawa todo\ni-edit burahin\ni-update tapusin\ni-update todo\nidagdag i-update\nilista aksyon\nilista i-edit\nilista isulat\nilista kahilingan\nilista linisin\nilista todo\nisulat gumawa\nisulat todo\nkahilingan user\nkumpletuhin task\nkunin todo\nlinisin todo\nlinisin user\nnilalaman status\npamahalaan ilista\npamahalaan user\nstatus aktibo\ntapusin ilista\ntapusin todo\ntask\ntask list\ntodo\ntodo burahin\ntodo gumawa\ntodo i-update\ntodo ilista\ntodo isulat\ntodo linisin\ntodo nilalaman\ntodo tapusin\nuser todo",
          vi: "cap nhat\ncập nhật\ncập nhật việc cần làm\ndanh sách tác vụ\ngỡ việc cần làm\nhanh dong\nhành động\nhành động viết\nhoan thanh\nhoàn thành\nhoàn thành liệt kê\nhoàn thành tác vụ\nhoàn thành việc cần làm\nket thuc\nkết thúc\nkết thúc việc cần làm\nkich hoat\nlấy việc cần làm\nliet ke\nliệt kê\nliệt kê việc cần làm\nnguoi dung\nngười dùng\nnhắc nhở\nquy trinh\nquy trình\ntac tu\ntác tử\ntác tử việc cần làm\ntac vu\ntác vụ\ntạo cập nhật\ntạo hoàn thành\ntạo việc cần làm\ntu dong hoa\ntự động hóa\ntự động hóa việc cần làm\nviec can lam\nviệc cần làm\nviệc cần làm cập nhật\nviệc cần làm hoàn thành\nviệc cần làm liệt kê\nviệc cần làm tạo\nviệc cần làm viết\nviệc cần làm xóa\nviết việc cần làm\nxóa người dùng\nxóa việc cần làm",
          "zh-CN":
            "代理 待办\n任务\n任务 待办\n内容 状态\n写入 创建\n写入 待办\n列出 写入\n列出 待办\n列出 操作\n列出 清除\n列出 编辑\n列出 请求\n创建 完成\n创建 待办\n创建 更新\n创建 添加\n删除 列出\n删除 待办\n完成 列出\n完成 待办\n待办\n待办 内容\n待办 写入\n待办 列出\n待办 创建\n待办 删除\n待办 完成\n待办 更新\n待办 清除\n截止日期\n提醒\n操作 写入\n更新 完成\n更新 待办\n添加 更新\n清除 待办\n清除 用户\n状态 活跃\n用户 待办\n移除 待办\n管理 列出\n管理 用户\n结束 待办\n编辑 删除\n自动化 待办\n获取 待办\n请求 用户\n跟进",
        },
      },
    },
    trade: {
      request: {
        base: "accepts\naccount\naccount inspect\naccounts\naccounts sessions\nconfirmation\nconfirmed\nconfirmed order\ncredentials\ncrypto trade\nfinance trade\ngoverned\nhyperliquid\nhyperliquid trade\nhyperliquid_trade\ninspect\ninspect account\nintent\nnever\noperation\noperation inspect\norder\norder intent\norder order\norder steward\norder submission\npayloads\npolymarket\npolymarket operation\npolymarket trade\npolymarket_trade\nrequires\nseparate\nseparate user\nsession\nsessions\nsteward\nsteward trade\nsteward_trade\nsubmission\nsubmit\nsubmit order\ntrade\ntrade order\ntrade_order\ntrading\ntrading account\ntrading accounts\ntrading_account\nuser\nuser confirmation\nvenue\nwallet trade",
        locales: {
          es: "accion\nbilletera\ncadena\ncripto\ncuenta\ndefi\ndinero\ndireccion\nfactura\nfinanzas\nfirmar transaccion\nherramienta\nintercambio\nliquidez\noperacion\norden\npedido\npedido pedido\nportafolio\nsaldo\nsolicitud\ntoken\ntransferir\nusuario\nwallet",
          ko: "거래 서명\n계정\n금융\n도구\n돈\n디파이\n사용자\n스왑\n암호화폐\n온체인\n요청\n유동성\n작업\n잔액\n전송\n주문\n주문 주문\n주소\n지갑\n청구서\n토큰\n포트폴리오",
          pt: "acao\nassinar transacao\ncarteira\nconta\ncripto\ndefi\ndinheiro\nendereco\nfatura\nferramenta\nfinancas\nliquidez\nonchain\noperacao\npedido\npedido pedido\nportfolio\nsaldo\nsolicitacao\ntoken\ntransferir\ntroca\nusuario\nwallet",
          tl: "account\naddress\naksyon\nbalance\ncrypto\ndefi\nfinance\ngumagamit\ninvoice\nkahilingan\nkasangkapan\nkuwenta\nliquidity\noperasyon\norder\norder order\npera\nportfolio\nsign transaction\nswap\ntoken\ntransfer\nuser\nwallet",
          vi: "chuyen\nchuyển\ncong cu\ncông cụ\ncrypto\ndefi\ndon hang\nđơn hàng\nđơn hàng đơn hàng\nhanh dong\nhành động\nký giao dịch\nnguoi dung\nngười dùng\nso du\nsố dư\ntai chinh\ntài chính\ntai khoan\ntài khoản\nthanh khoản\nthao tac\nthao tác\ntien\ntiền\ntien ma hoa\ntiền mã hóa\ntoken\nvi\nví\nyeu cau\nyêu cầu",
          "zh-CN":
            "交换\n代币\n余额\n加密货币\n发票\n地址\n工具\n投资组合\n操作\n流动性\n用户\n签名交易\n订单\n订单 订单\n请求\n财务\n账号\n账户\n转账\n钱\n钱包\n链上",
        },
      },
    },
    trust: {
      request: {
        base: "action\naction evaluate\nadmin\nadmin none\nadmin trust\naffecting\nagent_internal trust\nassign role\nassign_role\nassigns\nchange role\nchange_role\ncontrol\ncontrol action\nelevate permissions\nelevate_permissions\nelevation\nelevation requests\nentity\nevaluate\nevaluate reads\nevent\nevent request\ninteraction\ninteraction logs\nlogs\nlogs trust\nmake admin\nmake_admin\nnone\nowner\nowner admin\npermissions\npermissions update\nprofile\nprofile entity\nreads\nreads trust\nrecord\nrequest\nrequest elevation\nrequests\nrequests temporary\nrole\nrole assigns\nroles\nset permissions\nset_permissions\nsettings trust\nsystem\nsystem control\ntemporary\ntrust\ntrust affecting\ntrust interaction\ntrust management\ntrust operation\ntrust profile\ntrust system\ntrust_interaction\ntrust_management\ntrust_operation\ntrust_profile\nupdate\nupdate role\nworld",
        locales: {
          es: "accion\nactivar\nactualizar\nactualizar rol\nadministrador\nadministrador confianza\nagente\nagente confianza\najustes\nconfianza\nconfianza gestion\nconfianza operacion\nconfianza perfil\nconfiguracion\nconfiguracion confianza\ncontrolar\ncontrolar accion\ndueño\nestado interno\ngestion\ngestion interna\nherramienta\ninterno del agente\nleer\nleer confianza\nlogs\nmodelo\noperacion\npedir\nperfil\npermisos\npolitica\npreferencias\nregistros\nregistros confianza\nrol\nroles\nsolicitud",
          ko: "관리\n관리자\n관리자 신뢰\n구성\n권한\n내부 상태\n도구\n로그\n로그 신뢰\n모델 설정\n설정\n설정 신뢰\n소유자\n신뢰\n신뢰 관리\n신뢰 작업\n신뢰 프로필\n업데이트\n업데이트 역할\n에이전트\n에이전트 내부\n에이전트 신뢰\n역할\n요청\n읽기\n읽기 신뢰\n자체 관리\n작업\n정책\n제어\n제어 작업\n토글\n프로필\n환경설정",
          pt: "acao\nadministrador\nadministrador confianca\nagente\nagente confianca\nalternar\natualizar\natualizar funcao\nconfianca\nconfianca gerenciamento\nconfianca operacao\nconfianca perfil\nconfiguracao\nconfiguracoes\nconfiguracoes confianca\ncontrolar\ncontrolar acao\ndono\nestado interno\nferramenta\nfuncao\nfuncoes\ngerenciamento\ngestao interna\ninterno do agente\nler\nler confianca\nlogs\nlogs confianca\nmodelo\noperacao\npapel\npedir\nperfil\npermissoes\npolitica\npreferencias\nregistros\nsolicitacao",
          tl: "admin\nadmin tiwala\nagent\nagent tiwala\naksyon\nbasahin\nbasahin tiwala\nconfiguration\nhiling\ni-update\ni-update role\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nkontrol\nkontrol aksyon\nlogs\nlogs tiwala\nmay ari\nmodel settings\noperasyon\npahintulot\npamamahala\npatakaran\npreferences\nprofile\nrole\nsariling pamamahala\nsettings\nsettings tiwala\ntiwala\ntiwala operasyon\ntiwala pamamahala\ntiwala profile\ntoggle",
          vi: "cai dat\ncài đặt\ncài đặt tin cậy\ncap nhat\ncập nhật\ncập nhật vai trò\ncấu hình\nchu so huu\nchủ sở hữu\ncong cu\ncông cụ\ndieu khien\nđiều khiển\nđiều khiển hành động\nđọc tin cậy\nhanh dong\nhành động\nho so\nhồ sơ\nnhat ky\nnhật ký\nnhật ký tin cậy\nnoi bo tac tu\nnội bộ tác tử\nquan ly\nquản lý\nquan tri\nquản trị\nquản trị tin cậy\nquyền\ntac tu\ntác tử\ntác tử tin cậy\nthao tac\nthao tác\ntin cay\ntin cậy\ntin cậy hồ sơ\ntin cậy quản lý\ntin cậy thao tác\ntu quan ly\ntự quản lý\ntuy chon\ntùy chọn\nvai tro\nvai trò\nyeu cau\nyêu cầu",
          "zh-CN":
            "代理\n代理 信任\n代理内部\n信任\n信任 操作\n信任 管理\n信任 资料\n偏好\n内部状态\n工具\n开关\n所有者\n控制\n控制 操作\n操作\n日志\n日志 信任\n智能体\n更新\n更新 角色\n权限\n模型设置\n策略\n管理\n管理员\n管理员 信任\n自我管理\n角色\n设置\n设置 信任\n请求\n读取\n读取 信任\n资料\n配置",
        },
      },
    },
    tunnelCredentialToChildSession: {
      request: {
        base: "agent\nchild\nchild agent\nciphertext\ncredential\ndeliver sub agent credential\ndeliver_sub_agent_credential\nencrypt\nnamed\nonce\nprovide sub agent credential\nprovide_sub_agent_credential\nretrieve\nscope\nstage\nstage sub agent credential\nstage_sub_agent_credential\ntunnel credential to child session\ntunnel_credential_to_child_session\nunder\nvalue",
        locales: {
          es: "accion\nagente\nherramienta\nsolicitud\ntunel",
          ko: "도구\n에이전트\n요청\n작업\n터널",
          pt: "acao\nagente\nferramenta\nsolicitacao\ntunel",
          tl: "agent\naksyon\nkahilingan\nkasangkapan\ntunnel",
          vi: "cong cu\ncông cụ\nduong ham\nđường hầm\nhanh dong\nhành động\ntac tu\ntác tử\nyeu cau\nyêu cầu",
          "zh-CN": "代理\n工具\n操作\n智能体\n请求\n隧道",
        },
      },
    },
    turnAbort: {
      request: {
        base: "abort\nabort active\nactive\nactive message\ngiven\ngiven room\nhandler\nmessage\nmessage handler\nroom\nturn\nturn abort\nturn_abort",
        locales: {
          es: "accion\nactivo\nactivo mensaje\nchat\nherramienta\nmensaje\nsala\nsolicitud",
          ko: "도구\n메시지\n방\n요청\n작업\n채팅방\n활성\n활성 메시지",
          pt: "acao\nativo\nativo mensagem\nchat\nferramenta\nmensagem\nsala\nsolicitacao",
          tl: "aksyon\naktibo\naktibo mensahe\nkahilingan\nkasangkapan\nkuwarto\nmensahe\nroom",
          vi: "cong cu\ncông cụ\ndang hoat dong\nđang hoạt động\nđang hoạt động tin nhắn\nhanh dong\nhành động\nphong\nphòng\ntin nhan\ntin nhắn\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n房间\n操作\n活跃\n活跃 消息\n消息\n聊天室\n请求",
        },
      },
    },
    turnStatus: {
      request: {
        base: "active\nactive given\ngiven\ngiven room\nreport\nroom\nturn\nturn active\nturn status\nturn_status\nwhether",
        locales: {
          es: "accion\nactivo\nchat\nestado\nherramienta\nsala\nsolicitud",
          ko: "도구\n방\n상태\n요청\n작업\n채팅방\n활성",
          pt: "acao\nativo\nchat\nestado\nferramenta\nsala\nsolicitacao\nstatus",
          tl: "aksyon\naktibo\nkahilingan\nkasangkapan\nkuwarto\nroom\nstatus",
          vi: "cong cu\ncông cụ\ndang hoat dong\nđang hoạt động\nhanh dong\nhành động\nphong\nphòng\ntrang thai\ntrạng thái\nyeu cau\nyêu cầu",
          "zh-CN": "工具\n房间\n操作\n活跃\n状态\n聊天室\n请求",
        },
      },
    },
    updateApp: {
      request: {
        base: "app\napp details\napp settings\napps update app\nasks\nasks rename\nchange\nchange app\nchange_app\ncloud\ncloud app\ncontact\ncontact email\ndescription\ndetails\ndetails rename\nedit\nedit app\nedit change\nedit cloud\nedit_app\neliza\nemail\nemail user\nexisting\nfinance update app\nlogo\nlogo website\nmonetization\nrename\nrename app\nrename edit\nrename_app\nsettings\nsettings monetization\nsettings update app\nupdate\nupdate app\nupdate cloud app\nupdate existing\nupdate_app\nupdate_cloud_app\nuser\nuser asks\nwebsite\nwebsite contact",
        locales: {
          es: "accion\nactivar\nactualizar\nactualizar aplicacion\najustes\naplicacion\naplicacion actualizar aplicacion\naplicacion configuracion\naplicacion detalles\napp\nconfiguracion\nconfiguracion actualizar aplicacion\ncontacto\ncontacto correo\ncorreo\ncorreo usuario\ncuenta\ndetalles\ndinero\neditar\neditar aplicacion\nemail\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\npreguntar\nsaldo\nsitio web\nsitio web contacto\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 업데이트 앱\n세부정보\n앱\n앱 설정\n앱 세부정보\n앱 업데이트 앱\n업데이트\n업데이트 앱\n연락처\n연락처 이메일\n요청\n웹사이트\n웹사이트 연락처\n이메일\n이메일 사용자\n작업\n잔액\n질문\n청구서\n토글\n편집\n편집 앱\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo atualizar aplicativo\naplicativo configuracoes\naplicativo detalhes\napp\natualizar\natualizar aplicativo\nconfiguracao\nconfiguracoes\nconfiguracoes atualizar aplicativo\nconta\ncontato\ncontato email\ncorreio\ndetalhes\ndinheiro\neditar\neditar aplicativo\nemail\nemail usuario\nfatura\nferramenta\nfinancas\nmodelo\nperguntar\nportfolio\npreferencias\nsaldo\nsite\nsite contato\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp detalye\napp i-update app\napp settings\nbalance\nconfiguration\ncontact\ncontact email\ndetalye\nemail\nemail user\nfinance\ngumagamit\ni-edit\ni-edit app\ni-update\ni-update app\ninvoice\nkahilingan\nkasangkapan\nkoreo\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings i-update app\ntoggle\nuser\nuser magtanong\nwebsite\nwebsite contact",
          vi: "cai dat\ncài đặt\ncài đặt cập nhật ứng dụng\ncap nhat\ncập nhật\ncập nhật ứng dụng\ncấu hình\nchi tiet\nchi tiết\nchinh sua\nchỉnh sửa\nchỉnh sửa ứng dụng\ncong cu\ncông cụ\nemail\nemail người dùng\nhanh dong\nhành động\nhoi\nhỏi\nlien he\nliên hệ\nliên hệ email\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\nthu\nthư\ntien\ntiền\ntrang web\ntrang web liên hệ\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng cài đặt\nứng dụng cập nhật ứng dụng\nứng dụng chi tiết\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 更新 应用\n应用 设置\n应用 详情\n开关\n投资组合\n操作\n更新\n更新 应用\n模型设置\n用户\n用户 询问\n编辑\n编辑 应用\n网站\n网站 联系人\n联系人\n联系人 邮件\n设置\n设置 更新 应用\n询问\n详情\n请求\n财务\n账户\n邮件\n邮件 用户\n配置\n钱",
        },
      },
    },
    updateMonetization: {
      request: {
        base: "app\napp monetization\napps update monetization\nasks\nasks monetize\nchange\nchange markup\nchange_markup\ncloud\ncloud app\ndisable\ndisable earning\ndisable monetization\ndisable_monetization\nearning\nearning app\neliza\nenable\nenable disable\nenable monetization\nenable_monetization\nfinance update monetization\ninference\nmarkup\nmarkup enable\nmonetization\nmonetize\npercentage\npercentage user\nprice\npurchase\nset markup\nset price\nset_markup\nset_price\nsettings update monetization\nshare\nturn\nupdate monetization\nupdate_monetization\nuser\nuser asks",
        locales: {
          es: "accion\nactivar\nactivar desactivar\nactualizar\najustes\naplicacion\naplicacion actualizar\napp\nconfiguracion\nconfiguracion actualizar\ncuenta\ndesactivar\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n비활성화\n사용자\n사용자 질문\n설정\n설정 업데이트\n앱\n앱 업데이트\n업데이트\n요청\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정\n활성화\n활성화 비활성화",
          pt: "acao\nalternar\naplicativo\naplicativo atualizar\napp\nativar\nativar desativar\natualizar\nconfiguracao\nconfiguracoes\nconfiguracoes atualizar\nconta\ndesativar\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp i-update\nbalance\nconfiguration\nfinance\ngumagamit\ni-disable\ni-enable\ni-enable i-disable\ni-update\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings i-update\ntoggle\nuser\nuser magtanong",
          vi: "bat\nbật\nbật tắt\ncai dat\ncài đặt\ncài đặt cập nhật\ncap nhat\ncập nhật\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntat\ntắt\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng cập nhật\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n启用\n启用 禁用\n工具\n应用\n应用 更新\n开关\n投资组合\n操作\n更新\n模型设置\n用户\n用户 询问\n禁用\n设置\n设置 更新\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    views: {
      request: {
        base: "abre correo\nabrir correo\nadd app feature\nadd feature\narrange views\nbroadcast view event\nbuild app feature\nbuild view\ncall view capability\nchange view icon\ncheck email\ncheck inbox\ncheck messages\nclick in view\nclose all views\nclose view\ncreate note\ncreate plugin\ncreate sticky note\ncreate view\ndelete view\nedit view\ngenerate view icon\nget notes\ngo email\ngo inbox\ngo settings\ngo to settings\ngo to view\ninteract with view\ninvoke view capability\nlist available\nlist notes\nlist views\nmake view\nmanage navigate\nmostrar correo\nnavigate settings\nnavigate to view\nnotify view\nopen app builder\nopen apps\nopen email\nopen inbox\nopen messages\nopen settings\nopen task coordinator\nopen view\nopen view window\nopen wallet\nopen wallet view\npin view\nread email\nread messages\nregenerate view icon\nremove plugin\nremove view\nrestore view\nrevert plugin\nrevert view\nrevisa correo\nrevisar correo\nrollback plugin\nrollback view\nset flashlight\nset view icon\nshow app builder\nshow apps\nshow email\nshow inbox\nshow messages\nshow notes\nshow settings\nshow task coordinator\nshow view\nshow wallet\nsignal view\nsplit view\nsplit views\nswitch settings\nswitch view\ntile views\nturn off flashlight\nturn on flashlight\nundo plugin create\nundo view create\nuninstall view\nupdate view\nupdate view image\nuse view capability\nver correo\nview manager\nview open\nviews list\nwallet view\nwhat views",
        locales: {
          es: "abrir\nabrir aplicacion\nabrir bandeja de entrada\nabrir billetera\nabrir configuracion\nabrir correo\nabrir mensaje\nabrir tarea\nactualizar\nactualizar imagen\nagregar\nagregar aplicacion\nanadir\naplicacion\napp\nbandeja de entrada\nbilletera\nclic\ncomplemento\ncomprobar\nconfiguracion\ncorreo\ncrear\ncrear plugin\neditar\neliminar plugin\nemail\nfoto\ngenerar\nhacer clic\nimagen\nleer\nleer correo\nleer mensaje\nlistar\nllamada\nllamar\nmensaje\nmostrar\nobtener\nplugin\nplugin crear\nrevisar\nrevisar bandeja de entrada\nrevisar correo\nrevisar mensaje\ntarea\nwallet",
          ko: "가져오기\n검색\n관리\n도구\n메시지\n목록\n받은편지함\n사진\n삭제\n생성\n생성 플러그인\n설정\n쓰기\n앱\n업데이트\n업데이트 이미지\n열기\n열기 메시지\n열기 받은편지함\n열기 설정\n열기 앱\n열기 이메일\n열기 작업\n열기 지갑\n이메일\n이미지\n일정\n읽기\n읽기 메시지\n읽기 이메일\n작업\n전화\n제거\n제거 플러그인\n제어\n지갑\n추가\n추가 앱\n캘린더\n클릭\n통화\n편집\n플러그인\n플러그인 생성\n확인\n확인 메시지\n확인 받은편지함\n확인 이메일",
          pt: "abrir\nabrir aplicativo\nabrir caixa de entrada\nabrir carteira\nabrir configuracoes\nabrir email\nabrir mensagem\nabrir tarefa\nadicionar\nadicionar aplicativo\napagar\naplicativo\napp\natualizar\natualizar imagem\ncaixa de entrada\ncarteira\nchamada\nclicar\nconfiguracoes\ncorreio\ncriar\ncriar plugin\neditar\nemail\nexcluir\nfoto\ngerar\ngerenciar\nimagem\nler\nler email\nler mensagem\nligar\nlistar\nmensagem\nmostrar\nobter\nplugin\nplugin criar\nremover\nremover plugin\ntarefa\nverificar\nverificar caixa de entrada\nverificar email\nverificar mensagem\nwallet",
          tl: "aksyon\nalisin\nalisin plugin\napp\nbasahin\nbasahin email\nbasahin mensahe\nbuksan\nbuksan app\nbuksan email\nbuksan gawain\nbuksan inbox\nbuksan mensahe\nbuksan settings\nbuksan wallet\nbumuo\nburahin\nclick\nemail\ngawain\ngumawa\ngumawa plugin\ni-edit\ni-update\ni-update larawan\nidagdag\nidagdag app\nilista\ninbox\nisulat\nkalendaryo\nkasangkapan\nkontrol\nkoreo\nkunin\nlarawan\nmaghanap\nmensahe\npamahalaan\nplugin\nplugin gumawa\nsettings\nsuriin\nsuriin email\nsuriin inbox\nsuriin mensahe\ntawag\nwallet",
          vi: "cai dat\ncài đặt\ncap nhat\ncập nhật\ncập nhật hình ảnh\nchinh sua\nchỉnh sửa\ncong cu\ncông cụ\ndieu khien\nđiều khiển\nđọc email\nđọc tin nhắn\ngỡ plugin\nhanh dong\nhành động\nhinh anh\nhình ảnh\nhop thu\nhộp thư\nkiem tra\nkiểm tra\nkiểm tra email\nkiểm tra hộp thư\nkiểm tra tin nhắn\nliet ke\nliệt kê\nmở cài đặt\nmở email\nmở hộp thư\nmở nhiệm vụ\nmở tin nhắn\nmở ứng dụng\nmở ví\nnhiem vu\nnhiệm vụ\nplugin tạo\nquan ly\nquản lý\ntạo plugin\nthêm ứng dụng\ntim kiem\ntìm kiếm\ntin nhan\ntin nhắn\nung dung\nứng dụng\nyêu cầu",
          "zh-CN":
            "任务\n写入\n列出\n创建\n创建 插件\n删除\n图像\n图片\n应用\n打开\n打开 任务\n打开 应用\n打开 收件箱\n打开 消息\n打开 设置\n打开 邮件\n打开 钱包\n拨打\n控制\n插件\n插件 创建\n搜索\n操作\n收件箱\n日历\n更新\n更新 图片\n检查\n检查 收件箱\n检查 消息\n检查 邮件\n消息\n添加\n添加 应用\n点击\n生成\n移除\n移除 插件\n管理\n编辑\n获取\n设置\n读取\n读取 消息\n读取 邮件\n通话\n邮件\n钱包",
        },
      },
    },
    vision: {
      request: {
        base: "action\nanalyze scene\nanalyze_scene\nboth\ncamera\ncamera screen\ncapture\ncapture frame\ncapture get\ncapture image\ncapture mode\ncapture_frame\ncapture_image\ncoordinates\ndescribe\ndescribe capture\ndescribe scene\ndescribe_scene\nelements\nelements image\nentity\nentity identify\nentity inferred\nexplicitly\nfrugal\nget\nget screen\nget_screen\ngrounded\nidentify\nidentify person\nidentify_person\nimage\nimage mode\nimage switch\ninclude\ninferred\ninferred message\nlook around\nlook_around\nmessage\nmessage text\nmode\nname\nname entity\nname_entity\nocr screen\nocr_screen\nperson\nprovided\nread screen\nread_screen\nreadout\nscene\nscene capture\nscreen\nscreen both\nscreen elements\nscreen text\nscreen vision\nscreen_text\nscreenshot\nset vision mode\nset_vision_mode\nstart\nstructured\nswitch\nswitch vision\ntake photo\ntake picture\ntake_photo\ntake_picture\ntext\ntoken\ntrack\ntrack entity\ntrack_entity\ntracking\ntrue\nunless\nvisible\nvision\nvision check\nvision describe\nvision mode\nvision_check\nwhat do you see\nwhat_do_you_see",
        locales: {
          es: "accion\nanalizar\ncaptura de pantalla\ncapturar\ncapturar imagen\ncapturar obtener\ncomprobar\ndescribir\ndescribir capturar\nfoto\nherramienta\nidentificar\nimagen\ninferido\ninferido mensaje\nleer\nleer pantalla\nmensaje\nobtener\nobtener pantalla\nocr pantalla\npantalla\npantalla vision\nrevisar\nsolicitud\ntoken\nvision\nvision describir\nvision revisar",
          ko: "ocr 화면\n가져오기\n가져오기 화면\n도구\n메시지\n분석\n비전\n비전 설명\n비전 확인\n사진\n설명\n설명 캡처\n스크린샷\n식별\n요청\n이미지\n읽기\n읽기 화면\n작업\n추론\n추론 메시지\n캡처\n캡처 가져오기\n캡처 이미지\n토큰\n화면\n화면 비전\n확인",
          pt: "acao\nanalisar\ncaptura de tela\ncapturar\ncapturar imagem\ncapturar obter\ndescrever\ndescrever capturar\nferramenta\nfoto\nidentificar\nimagem\ninferido\ninferido mensagem\nler\nler tela\nmensagem\nobter\nobter tela\nocr tela\nsolicitacao\ntela\ntela visao\ntoken\nverificar\nvisao\nvisao descrever\nvisao verificar",
          tl: "aksyon\nbasahin\nbasahin screen\nhinula\nhinula mensahe\nilarawan\nilarawan kuha\nkahilingan\nkasangkapan\nkuha\nkuha kunin\nkuha larawan\nkunin\nkunin screen\nlarawan\nmensahe\nocr screen\nscreen\nscreen vision\nscreenshot\nsuriin\ntoken\ntukuyin\nvision\nvision ilarawan\nvision suriin",
          vi: "anh\nảnh\nanh chup man hinh\nảnh chụp màn hình\nchup\nchụp\nchụp hình ảnh\nchụp lấy\ncong cu\ncông cụ\ndoc\nđọc\nđọc màn hình\nhanh dong\nhành động\nhinh anh\nhình ảnh\nkiem tra\nkiểm tra\nlay\nlấy\nlấy màn hình\nman hinh\nmàn hình\nmàn hình thị giác\nmo ta\nmô tả\nmô tả chụp\nnhan dang\nnhận dạng\nocr màn hình\nphan tich\nphân tích\nsuy luan\nsuy luận\nsuy luận tin nhắn\nthi giac\nthị giác\nthị giác kiểm tra\nthị giác mô tả\ntin nhan\ntin nhắn\ntoken\nyeu cau\nyêu cầu",
          "zh-CN":
            "ocr 屏幕\n代币\n令牌\n分析\n图像\n图片\n屏幕\n屏幕 视觉\n工具\n截图\n捕获\n捕获 图片\n捕获 获取\n推断\n推断 消息\n描述\n描述 捕获\n操作\n检查\n消息\n视觉\n视觉 描述\n视觉 检查\n获取\n获取 屏幕\n识别\n请求\n读取\n读取 屏幕",
        },
      },
    },
    wallet: {
      request: {
        base: "action\naddress\namount\nanalytics\nbirdeye\nbirdeye lookup\nbirdeye search\nbirdeye_lookup\nbirdeye_search\nbridge\nchain\nchain token\ncross chain transfer\ncross_chain_transfer\ncrypto wallet\ndata\ndestination\nfinance wallet\nhandler\nhandlers\ninfo\ninfo search\nlookup\nmarket\nmode\nmode run\nomit\nonly\noperations\noperations through\nparam\nparams\nportfolio\nprepare transfer\nprepare_transfer\nproviders\npump\npump fun buy\npump token\npump_fun_buy\npumpfun buy\npumpfun_buy\nquery\nrecipient\nregistered\nregistry\nroute\nroute wallet\nrun\nrun bridge\nsearch\nsearch address\nslippage\nsource\nsubaction\nsupports\nswap\nswap solana\nswap_solana\ntarget\nthrough\ntoken\ntoken amount\ntoken info\ntoken operations\ntoken token\ntoken_info\ntransfer\ntransfer token\ntransfer_token\nuniform\nuses\nwallet\nwallet action\nwallet gov\nwallet operations\nwallet search address\nwallet swap\nwallet token\nwallet transfer\nwallet wallet\nwallet_action\nwallet_gov\nwallet_search_address\nwallet_swap\nwallet_transfer",
        locales: {
          es: "accion\nbilletera\nbilletera accion\nbilletera buscar\nbilletera operacion\nbuscar\ncadena\nconsulta\ncripto\ncripto billetera\ncuenta\ndefi\ndinero\ndireccion\nejecutar\nfactura\nfinanzas\nfirmar transaccion\nherramienta\nintercambio\nliquidez\noperacion\nportafolio\nsaldo\nsolicitud\ntoken\ntransferir\nwallet",
          ko: "거래 서명\n검색\n계정\n금융\n도구\n돈\n디파이\n스왑\n실행\n암호화폐\n암호화폐 지갑\n온체인\n요청\n유동성\n작업\n잔액\n전송\n주소\n지갑\n지갑 검색\n지갑 작업\n질의\n청구서\n쿼리\n토큰\n포트폴리오",
          pt: "acao\nassinar transacao\nbuscar\ncarteira\ncarteira acao\ncarteira buscar\ncarteira operacao\nconsulta\nconta\ncripto\ncripto carteira\ndefi\ndinheiro\nendereco\nexecutar\nfatura\nferramenta\nfinancas\nliquidez\nonchain\noperacao\nportfolio\nsaldo\nsolicitacao\ntoken\ntransferir\ntroca\nwallet",
          tl: "account\naddress\naksyon\nbalance\ncrypto\ncrypto wallet\ndefi\nfinance\ninvoice\nkahilingan\nkasangkapan\nliquidity\nmaghanap\noperasyon\npatakbuhin\npera\nportfolio\nquery\nsign transaction\nswap\ntoken\ntransfer\nwallet\nwallet aksyon\nwallet maghanap\nwallet operasyon",
          vi: "chay\nchạy\nchuyen\nchuyển\ncong cu\ncông cụ\ncrypto\ndefi\nhanh dong\nhành động\nký giao dịch\nso du\nsố dư\ntai chinh\ntài chính\nthanh khoản\nthao tac\nthao tác\ntien\ntiền\ntien ma hoa\ntiền mã hóa\ntiền mã hóa ví\ntim kiem\ntìm kiếm\ntoken\ntruy van\ntruy vấn\nvi\nví\nví hành động\nví thao tác\nví tìm kiếm\nyeu cau\nyêu cầu",
          "zh-CN":
            "交换\n代币\n令牌\n余额\n加密货币\n加密货币 钱包\n发票\n地址\n工具\n投资组合\n搜索\n操作\n查询\n流动性\n签名交易\n请求\n财务\n账户\n转账\n运行\n钱\n钱包\n钱包 搜索\n钱包 操作\n链上",
        },
      },
    },
    webFetch: {
      request: {
        base: "50000\naddresses\nallow\nautomation web fetch\nbinary\nbinary content\nblocked\nblocks\nblocks private\nblog\nblog posts\nbody\ncapped\nchars\ncode web fetch\ncoding\ncoding tools\ncollapsed\nconstructing\ncontent\ndefault\ndocumentation\ndownload page\ndownload_page\nexchange\nextraction\nfetch\nfetch url\nfetch_url\nget url\nget_url\nhosts\nhtml\nhttp\nhttp get\nhttp_get\nhttps\ninternal\njson\nlive\nlocalhost\nlookup web\nlookup_web\nloopback\nover\nover web\noversized\npasting\npasting user\npermit\nplain\nposts\nposts pasting\nprefer\nprices\nprivate\npublic\nrates\nreadable\nreading\nreads\nredirects\nreferenced\nresponses\nreturn\nsearch\nsearch live\nsingle\nspecific\nspot\nstripped\nsupports\ntags\nterminal web fetch\ntext\nthem\ntimeouts\ntools\ntools web\nurls\nuser\nuser referenced\nvalues\nweather\nweb\nweb fetch\nweb lookup\nweb search\nweb web fetch\nweb_fetch\nweb_lookup\nyourself\nyourself blocks",
        locales: {
          es: "abrir url\naccion\nautomatizacion\nautomatizacion web\nbash\nbloquear\nbuscar\nbuscar web\ncodigo\ncodigo web\ncontenido\ncron\ndepurar\ndescargar\ndescargar pagina\ndisparador\nflujo de trabajo\nherramienta\nimplementar\ninformacion actual\ninternet\nleer\nlinea de comandos\nmonitor\nobtener\nobtener url\npagina\nproceso\nprogramacion\nprueba\npublicacion\npublicar\nrepositorio\nshell\nsolicitud\nterminal\nultimo\nusuario\nweb\nweb buscar",
          ko: "url 열기\n가져오기\n가져오기 url\n검색\n게시\n게시물\n구현\n내용\n다운로드\n다운로드 페이지\n도구\n디버그\n명령줄\n모니터\n배시\n사용자\n셸\n요청\n워크플로\n웹\n웹 검색\n인터넷\n읽기\n자동화\n자동화 웹\n작업\n저장소\n차단\n최신\n최신 정보\n코드\n코드 웹\n콘텐츠\n크론\n터미널\n테스트\n트리거\n페이지\n프로그래밍\n프로세스",
          pt: "abrir url\nacao\nautomacao\nautomacao web\nbaixar\nbaixar pagina\nbash\nbloquear\nbuscar\nbuscar na web\ncodigo\ncodigo web\nconteudo\ncron\ndepurar\nferramenta\nfluxo de trabalho\ngatilho\nimplementar\ninformacao atual\ninternet\nler\nlinha de comando\nmonitor\nobter\nobter url\npagina\npostagem\nprocesso\nprogramacao\npublicar\nrepositorio\nshell\nsolicitacao\nterminal\nteste\nusuario\nweb\nweb buscar",
          tl: "aksyon\nautomation\nautomation web\nbasahin\nbash\ncode\ncode web\ncommand line\ncron\ndebug\ngumagamit\ni-block\ni-download\ni-download pahina\ninternet\nipatupad\nkahilingan\nkasalukuyang impormasyon\nkasangkapan\nkunin\nkunin url\nmaghanap\nmonitor\nnilalaman\nopen url\npahina\npost\nprocess\nprogramming\nrepo\nsearch web\nshell\nterminal\ntest\ntool\ntrigger\nuser\nweb\nweb maghanap\nworkflow",
          vi: "bai dang\nbài đăng\nbash\nchan\nchặn\ncong cu\ncông cụ\ndong lenh\ndòng lệnh\nhanh dong\nhành động\ninternet\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nlay\nlấy\nlấy url\nma\nmã\nmã web\nnguoi dung\nngười dùng\nnoi dung\nnội dung\nquy trinh\nquy trình\nshell\ntai xuong\ntải xuống\ntải xuống trang\nterminal\nthong tin hien tai\nthông tin hiện tại\ntiến trình\ntim kiem\ntìm kiếm\ntìm web\ntu dong hoa\ntự động hóa\ntự động hóa web\nweb\nweb tìm kiếm\nyeu cau\nyêu cầu",
          "zh-CN":
            "Bash\n下载\n下载 页面\n互联网\n仓库\n代码\n代码 网页\n内容\n最新信息\n发布\n命令行\n定时\n实现\n工作流\n工具\n帖子\n打开网址\n搜索\n操作\n标准输出\n测试\n用户\n监控\n终端\n编程\n网络\n网页\n网页 搜索\n网页搜索\n自动化\n自动化 网页\n获取\n获取 url\n触发器\n请求\n读取\n调试\n进程\n阻止\n页面",
        },
      },
    },
    webSearch: {
      request: {
        base: "access\nanswer\nanswer does\nautomation web search\nbounded\nbrowser\nbrowser access\nchanged\ncode web search\ncontrol\ncontrol browser\ncrypto web search\ndocuments web search\ndoes\ndoes control\neliza\neliza answer\nendpoint\nendpoint search\nexchange\nexternal\nfacts\nfallback\nfetch\nfinance web search\nfind information\nfind online\nfind_information\nfind_online\nfirst\ngeneral web search\nhave\ninformation\ninternet search\ninternet_search\njson\nkeyless\nkeyless search\nlive\nlookup\nnews\nonline search\nonline_search\nopen\nopen web\nparallel\nplaces\nprefer\nprefer web\nprice\nprivate accounts\nproducts\nproducts places\npublic\npublic web\nquery web\nquery_web\nranked\nrate\nrecommendations\nrecommendations products\nresult\nresults\nreturning\nreturns\nsearch\nsearch engine\nsearch internet\nsearch open\nsearch public\nsearch snippets\nsearch uses\nsearch web\nsearch_engine\nsearch_web\nsnippets\nsource\nspot\nterminal web search\ntext\nthat\nuses\nusing\nvalue\nvalues\nweather\nweb\nweb external\nweb facts\nweb fetch\nweb lookup\nweb query\nweb search\nweb web search\nweb_lookup\nweb_search",
        locales: {
          es: "abrir url\nabrir web\narchivo\nautomatizacion\nautomatizacion web buscar\nbash\nbuscar abrir\nbuscar web\ncadena\nchat general\ncodigo\ncodigo web buscar\nconsulta web\ncontrolar navegador\ncripto\ncripto web buscar\ncuenta\ndefi\ndepurar\ndinero\ndocumento\ndocumento web buscar\ndocumentos\nfactura\nfinanzas\nflujo de trabajo\ngeneral web buscar\nguardar notas\nimplementar\ninformacion actual\nintercambio\ninternet\nlinea de comandos\nliquidez\nnotas\nportafolio\nproceso\nprogramacion\nprueba\nrepositorio\nsaldo\nshell\nterminal\ntoken\nultimo\nweb\nweb buscar\nweb consulta",
          ko: "url 열기\n검색 열기\n검색 웹\n계정\n구현\n금융\n노트\n돈\n디버그\n디파이\n명령줄\n문서\n문서 웹 검색\n배시\n셸\n스왑\n암호화폐\n암호화폐 웹 검색\n열기 웹\n온체인\n워크플로\n웹\n웹 검색\n웹 쿼리\n유동성\n인터넷\n일반 대화\n일반 웹 검색\n자동화\n자동화 웹 검색\n잔액\n저장\n저장소\n제어 브라우저\n청구서\n최신\n최신 정보\n코드\n코드 웹 검색\n쿼리 웹\n터미널\n테스트\n토큰\n트리거\n파일 내용\n포트폴리오\n프로그래밍\n프로세스",
          pt: "abrir url\nabrir web\narquivo\nautomacao\nautomacao web buscar\nbash\nbuscar abrir\nbuscar na web\nbuscar web\nchat geral\ncodigo\ncodigo web buscar\nconsulta web\nconta\ncontrolar navegador\ncripto\ncripto web buscar\ndefi\ndepurar\ndinheiro\ndocumento\ndocumento web buscar\ndocumentos\nfatura\nfinancas\nfluxo de trabalho\ngeral web buscar\nimplementar\ninformacao atual\ninternet\nlinha de comando\nliquidez\nnotas\nonchain\nportfolio\nprocesso\nprogramacao\nrepositorio\nsaldo\nsalvar notas\nshell\nterminal\nteste\ntoken\ntroca\nweb\nweb buscar\nweb consulta",
          tl: "account\nautomation\nautomation web maghanap\nbalance\nbash\nbuksan web\ncode\ncode web maghanap\ncommand line\ncron\ncrypto\ncrypto web maghanap\ndebug\ndefi\ndokumento\ndokumento web maghanap\nfinance\ngeneral chat\ni-save\ninternet\ninvoice\nipatupad\nkasalukuyang impormasyon\nkontrol browser\nliquidity\nmaghanap buksan\nmaghanap web\nnilalaman ng file\nnotes\nopen url\npangkalahatan web maghanap\npera\nportfolio\nprocess\nprogramming\nquery web\nrepo\nsearch web\nshell\nswap\nterminal\ntest\ntoken\ntrigger\nweb\nweb maghanap\nweb query\nworkflow",
          vi: "dieu khien\nđiều khiển\nđiều khiển trình duyệt\ndong lenh\ndòng lệnh\nghi chu\nghi chú\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nlưu ghi chú\nmã web tìm kiếm\nnói chuyện\nquy trinh\nquy trình\nso du\nsố dư\ntai chinh\ntài chính\ntai lieu\ntài liệu\nthanh khoản\nthong tin hien tai\nthông tin hiện tại\ntien ma hoa\ntiền mã hóa\ntiến trình\ntim kiem\ntìm kiếm\ntìm kiếm web\ntìm web\ntra loi\ntrả lời\ntrinh duyet\ntrình duyệt\ntro chuyen\ntrò chuyện\ntruy van\ntruy vấn\ntruy vấn web\ntu dong hoa\ntự động hóa\ntự động hóa web tìm kiếm\nweb tìm kiếm\nweb truy vấn",
          "zh-CN":
            "Bash\n互联网\n交换\n仓库\n代币\n代码\n代码 网页 搜索\n余额\n保存笔记\n最新信息\n加密货币\n加密货币 网页 搜索\n发票\n命令行\n定时\n实现\n工作流\n打开 网页\n打开网址\n投资组合\n控制 浏览器\n搜索 打开\n搜索 网页\n文件内容\n文档\n文档 网页 搜索\n查询 网页\n标准输出\n流动性\n测试\n监控\n笔记\n终端\n编程\n网络\n网页 搜索\n网页 查询\n网页搜索\n自动化\n自动化 网页 搜索\n触发器\n调试\n财务\n账户\n进程\n通用 网页 搜索\n钱\n链上",
        },
      },
    },
    window: {
      request: {
        base: "action\naction list\naction manage\nactions\nactions list\narrange\nautomation window\nclose\ncomputer\ncomputer file\ncomputer service\ndesktop\ndesktop windows\nfile\nfile shell\nfocus\nkeyboard\nkeyboard computer\nlist\nlist focus\nlocal\nlocal desktop\nmanage\nmanage local\nmanage window\nmanage_window\nmaximize\nminimize\nmove\npointer\nrestore\nscreen_time window\nservice\nservice actions\nshell\nshell file\nswitch\nuse window\nuse_window\nwindow\nwindow action\nwindow_action\nwindows\nwindows computer",
        locales: {
          es: "accion\naccion gestionar\naccion listar\nadministrar\narchivo\nautomatizacion\ncomputadora\ncomputadora archivo\ncron\ndisparador\nenfoque\nescritorio\nflujo de trabajo\ngestionar\nherramienta\nlimites de apps\nlistar\nmonitor\nmostrar\nordenador\npantalla\nsolicitud\ntiempo de pantalla\nuso del dispositivo",
          ko: "관리\n기기 사용\n데스크톱\n도구\n모니터\n목록\n사용 보고서\n스크린 타임\n앱 제한\n요청\n워크플로\n자동화\n작업\n작업 관리\n작업 목록\n집중\n컴퓨터\n컴퓨터 파일\n크론\n트리거\n파일\n화면",
          pt: "acao\nacao gerenciar\nacao listar\narea de trabalho\narquivo\nautomacao\ncomputador\ncomputador arquivo\ncron\nferramenta\nfluxo de trabalho\nfoco\ngatilho\ngerenciar\nlimites de app\nlistar\nmonitor\nmostrar\nsolicitacao\ntela\ntempo de tela\nuso do dispositivo",
          tl: "aksyon\naksyon ilista\naksyon pamahalaan\napp limits\nautomation\ncomputer\ncomputer file\ncron\ndesktop\nfile\nfocus\ngamit ng device\nilista\nkahilingan\nkasangkapan\nmonitor\npamahalaan\nscreen\nscreen time\ntrigger\nworkflow",
          vi: "cong cu\ncông cụ\ngiới hạn ứng dụng\nhanh dong\nhành động\nhành động liệt kê\nhành động quản lý\nkich hoat\nliet ke\nliệt kê\nman hinh\nmàn hình\nmay tinh\nmáy tính\nmay tinh de ban\nmáy tính để bàn\nmáy tính tệp\nquan ly\nquản lý\nquy trinh\nquy trình\ntep\ntệp\nthoi gian man hinh\nthời gian màn hình\ntu dong hoa\ntự động hóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "专注\n使用报告\n列出\n定时\n屏幕\n屏幕时间\n工作流\n工具\n应用限制\n操作\n操作 列出\n操作 管理\n文件\n桌面\n电脑\n电脑 文件\n监控\n管理\n自动化\n触发器\n设备使用\n请求",
        },
      },
    },
    withdrawAppEarnings: {
      request: {
        base: "app\napp earnings\napps withdraw app earnings\nask\nask only\nasks\nasks withdraw\ncash\ncash out\ncash out app\ncash request\ncash_out\ncash_out_app\ncloud\ncloud app\nconfirm\nconfirmation\nconfirms\ndashboard\nearnings\neliza\nexplicit\nfinance withdraw app earnings\nfirst\nfirst ask\nhands\nintent\nlink\nlink user\nmoney\nonly\npayout\npayout app\nrequest\nrequest payout\nrequest_payout\nrequires\nsettings withdraw app earnings\nstep\nuser\nuser asks\nwithdraw\nwithdraw app earnings\nwithdraw earnings\nwithdraw_app_earnings\nwithdraw_earnings",
        locales: {
          es: "accion\nactivar\najustes\naplicacion\naplicacion aplicacion\napp\nconfiguracion\nconfiguracion aplicacion\ncuenta\ndinero\nfactura\nfinanzas\nherramienta\nmodelo\npedir\nportafolio\npreferencias\npreguntar\nsaldo\nsolicitud\nusuario\nusuario preguntar",
          ko: "계정\n구성\n금융\n도구\n돈\n모델 설정\n사용자\n사용자 질문\n설정\n설정 앱\n앱\n앱 앱\n요청\n작업\n잔액\n질문\n청구서\n토글\n포트폴리오\n환경설정",
          pt: "acao\nalternar\naplicativo\naplicativo aplicativo\napp\nconfiguracao\nconfiguracoes\nconfiguracoes aplicativo\nconta\ndinheiro\nfatura\nferramenta\nfinancas\nmodelo\npedir\nperguntar\nportfolio\npreferencias\nsaldo\nsolicitacao\nusuario\nusuario perguntar",
          tl: "account\naksyon\napp\napp app\nbalance\nconfiguration\nfinance\ngumagamit\nhiling\ninvoice\nkahilingan\nkasangkapan\nmagtanong\nmodel settings\npera\nportfolio\npreferences\nsettings\nsettings app\ntoggle\nuser\nuser magtanong",
          vi: "cai dat\ncài đặt\ncài đặt ứng dụng\ncấu hình\ncong cu\ncông cụ\nhanh dong\nhành động\nhoi\nhỏi\nnguoi dung\nngười dùng\nngười dùng hỏi\nso du\nsố dư\ntai chinh\ntài chính\ntien\ntiền\ntuy chon\ntùy chọn\nung dung\nứng dụng\nứng dụng ứng dụng\nyeu cau\nyêu cầu",
          "zh-CN":
            "余额\n偏好\n发票\n工具\n应用\n应用 应用\n开关\n投资组合\n操作\n模型设置\n用户\n用户 询问\n设置\n设置 应用\n询问\n请求\n财务\n账户\n配置\n钱",
        },
      },
    },
    workflow: {
      request: {
        base: "activate workflow\nactivate_workflow\nagent_internal workflow\nautomation\nautomation workflow\nautomations\ncreate automation\ncreate workflow\ncreate_automation\ncreate_workflow\ndeactivate workflow\ndeactivate_workflow\ndelete automation\ndelete workflow\ndelete_automation\ndelete_workflow\nedit automation\nedit workflow\nedit_automation\nedit_workflow\ngeneral workflow\nlist workflows\nlist_workflows\nrun automation\nrun workflow\nrun_automation\nrun_workflow\ntasks workflow\nupdate workflow\nupdate_workflow\nworkflow\nworkflow create\nworkflow executions\nworkflow_create\nworkflow_executions",
        locales: {
          es: "accion\nactualizar\nactualizar flujo de trabajo\nagente\nagente flujo de trabajo\nautomatizacion\nautomatizacion flujo de trabajo\nborrar\nchat general\nconversacion\ncrear\ncrear automatizacion\ncrear flujo de trabajo\ncron\ndisparador\neditar\neditar automatizacion\neditar flujo de trabajo\nejecutar\nejecutar automatizacion\nejecutar flujo de trabajo\neliminar\neliminar automatizacion\neliminar flujo de trabajo\nestado interno\nfecha limite\nflujo de trabajo\nflujo de trabajo crear\ngeneral\ngeneral flujo de trabajo\ngestion interna\nhablar\nherramienta\ninterno del agente\nlistar\nlistar flujo de trabajo\nmonitor\nmostrar\npendiente\nrecordatorio\nrespuesta\nseguimiento\nsolicitud\ntarea\ntarea flujo de trabajo\ntareas",
          ko: "내부 상태\n답변\n도구\n리마인더\n마감일\n말하기\n모니터\n목록\n목록 워크플로\n삭제\n삭제 워크플로\n삭제 자동화\n생성\n생성 워크플로\n생성 자동화\n실행\n실행 워크플로\n실행 자동화\n업데이트\n업데이트 워크플로\n에이전트\n에이전트 내부\n에이전트 워크플로\n요청\n워크플로\n워크플로 생성\n일반\n일반 대화\n일반 워크플로\n자동화\n자동화 워크플로\n자체 관리\n작업\n작업 워크플로\n채팅\n크론\n트리거\n편집\n편집 워크플로\n편집 자동화\n할 일\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\nagente\nagente fluxo de trabalho\napagar\natualizar\natualizar fluxo de trabalho\nautomacao\nautomacao fluxo de trabalho\nchat geral\nconversa\ncriar\ncriar automacao\ncriar fluxo de trabalho\ncron\neditar\neditar automacao\neditar fluxo de trabalho\nestado interno\nexcluir\nexcluir automacao\nexcluir fluxo de trabalho\nexecutar\nexecutar automacao\nexecutar fluxo de trabalho\nfalar\nferramenta\nfluxo de trabalho\nfluxo de trabalho criar\ngatilho\ngeral\ngeral fluxo de trabalho\ngestao interna\ninterno do agente\nlembrete\nlistar\nlistar fluxo de trabalho\nmonitor\nmostrar\nprazo\nresposta\nsolicitacao\ntarefa\ntarefa fluxo de trabalho\ntarefas",
          tl: "agent\nagent workflow\naksyon\nautomation\nautomation workflow\nburahin\nburahin automation\nburahin workflow\ncron\ndeadline\nfollow up\ngawain\ngawain workflow\ngeneral chat\ngumawa\ngumawa automation\ngumawa workflow\ni-edit\ni-edit automation\ni-edit workflow\ni-update\ni-update workflow\nilista\nilista workflow\ninternal ng agent\ninternal state\nkahilingan\nkasangkapan\nmakipag-usap\nmonitor\npaalala\npangkalahatan\npangkalahatan workflow\npatakbuhin\npatakbuhin automation\npatakbuhin workflow\nsagot\nsariling pamamahala\ntask\ntodo\ntrigger\nusap\nworkflow\nworkflow gumawa",
          vi: "cap nhat\ncập nhật\ncập nhật quy trình\nchạy quy trình\nchạy tự động hóa\nchinh sua\nchỉnh sửa\nchỉnh sửa quy trình\nchỉnh sửa tự động hóa\nchung quy trình\ncong cu\ncông cụ\nhanh dong\nhành động\nkich hoat\nliet ke\nliệt kê\nliệt kê quy trình\nnhắc nhở\nnhiem vu\nnhiệm vụ\nnhiệm vụ quy trình\nnoi bo tac tu\nnội bộ tác tử\nnói chuyện\nquy trinh\nquy trình\nquy trình tạo\ntac tu\ntác tử\ntác tử quy trình\ntac vu\ntác vụ\ntạo quy trình\ntạo tự động hóa\ntra loi\ntrả lời\ntro chuyen\ntrò chuyện\ntu dong hoa\ntự động hóa\ntự động hóa quy trình\ntu quan ly\ntự quản lý\nviec can lam\nviệc cần làm\nxóa quy trình\nxóa tự động hóa",
          "zh-CN":
            "代理\n代理 工作流\n代理内部\n任务\n任务 工作流\n内部状态\n列出\n列出 工作流\n创建\n创建 工作流\n创建 自动化\n删除\n删除 工作流\n删除 自动化\n回复\n回答\n定时\n对话\n工作流\n工作流 创建\n工具\n待办\n截止日期\n提醒\n操作\n普通聊天\n智能体\n更新\n更新 工作流\n监控\n编辑\n编辑 工作流\n编辑 自动化\n自动化\n自动化 工作流\n自我管理\n触发器\n请求\n跟进\n运行\n运行 工作流\n运行 自动化\n通用\n通用 工作流",
        },
      },
    },
    workThread: {
      request: {
        base: "actions\nattach\nautomation work thread\ncomplete\ncomplete merge\ncompleted\ncreate\ncreate steer\ncreate thread\ncreate_thread\ndomain\nfollow\nfollow only\nfollowup\nlifecycle\nlifecycle create\nmerge\nmessage create group handoff\nmessage_create_group_handoff\nmessaging\nmessaging work thread\nmessaging workflow\nonly\nowner\nrefs\nrefs schedule\nrouting\nschedule\nschedule follow\nschedule thread followup\nschedule_thread_followup\nsource\nsteer\nsteer stop\nsteer thread\nsteer_thread\nstop\nstop thread\nstop wait\nstop waiting\nstop_thread\ntask\ntask messaging\ntasks work thread\nthread\nthread control\nthread_control\nwait\nwait complete\nwaiting\nwork\nwork task\nwork thread\nwork_thread\nworkflow\nworkflow actions",
        locales: {
          es: "accion\nagendar\nautomatizacion\ncompletar\ncontrolar\ncrear\ncron\ndetener\ndisparador\nfecha limite\nflujo de trabajo\nflujo de trabajo accion\nherramienta\nmensaje\nmensaje crear\nmonitor\nparar\npendiente\nprogramar\nprogramar seguir\nrecordatorio\nseguimiento\nseguir\nsolicitud\ntarea\ntareas\nterminar",
          ko: "도구\n리마인더\n마감일\n메시지\n메시지 생성\n모니터\n생성\n예약\n예약 팔로우\n완료\n요청\n워크플로\n워크플로 작업\n일정\n자동화\n작업\n제어\n중지\n크론\n트리거\n팔로우\n할 일\n후속 조치",
          pt: "acao\nacompanhamento\nafazer\nagendar\nagendar seguir\nautomacao\ncompletar\nconcluir\ncontrolar\ncriar\ncron\nferramenta\nfluxo de trabalho\nfluxo de trabalho acao\ngatilho\nlembrete\nmensagem\nmensagem criar\nmonitor\nparar\nprazo\nseguir\nsolicitacao\ntarefa\ntarefas",
          tl: "aksyon\nautomation\ncron\ndeadline\nfollow up\ngawain\ngumawa\ni-schedule\ni-schedule sundan\nitigil\nkahilingan\nkasangkapan\nkontrol\nmensahe\nmensahe gumawa\nmonitor\npaalala\nsundan\ntapusin\ntask\ntodo\ntrigger\nworkflow\nworkflow aksyon",
          vi: "cong cu\ncông cụ\ndieu khien\nđiều khiển\ndung\ndừng\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nkich hoat\nlen lich\nlên lịch\nlên lịch theo dõi\nnhắc nhở\nnhiem vu\nnhiệm vụ\nquy trinh\nquy trình\nquy trình hành động\ntac vu\ntác vụ\ntao\ntạo\ntheo doi\ntheo dõi\ntin nhan\ntin nhắn\ntin nhắn tạo\ntu dong hoa\ntự động hóa\nviec can lam\nviệc cần làm\nyeu cau\nyêu cầu",
          "zh-CN":
            "任务\n停止\n关注\n创建\n安排\n安排 关注\n完成\n定时\n工作流\n工作流 操作\n工具\n待办\n截止日期\n控制\n提醒\n操作\n消息\n消息 创建\n监控\n自动化\n触发器\n请求\n跟进",
        },
      },
    },
    worktree: {
      request: {
        base: "action\naction enter\nautomation worktree\ncode worktree\ncreates\ncreates switches\nenter\nenter creates\nexit\ngit worktree\ngit_worktree\nleaves\nleaves remove\nmanage\nmanage session\nremove\nsession\nstack\nswitches\nterminal worktree\numbrella\numbrella action\nworktree",
        locales: {
          es: "accion\nadministrar\nautomatizacion\nbash\ncodigo\ncrear\ncron\ndepurar\ndisparador\neliminar\nflujo de trabajo\ngestionar\nherramienta\nimplementar\nlinea de comandos\nmonitor\nproceso\nprogramacion\nprueba\nquitar\nrepositorio\nshell\nsolicitud\nterminal",
          ko: "관리\n구현\n도구\n디버그\n명령줄\n모니터\n배시\n생성\n셸\n요청\n워크플로\n자동화\n작업\n저장소\n제거\n코드\n크론\n터미널\n테스트\n트리거\n프로그래밍\n프로세스",
          pt: "acao\nautomacao\nbash\ncodigo\ncriar\ncron\ndepurar\nferramenta\nfluxo de trabalho\ngatilho\ngerenciar\nimplementar\nlinha de comando\nmonitor\nprocesso\nprogramacao\nremover\nrepositorio\nshell\nsolicitacao\nterminal\nteste",
          tl: "aksyon\nalisin\nautomation\nbash\ncode\ncommand line\ncron\ndebug\ngumawa\nipatupad\nkahilingan\nkasangkapan\nmonitor\npamahalaan\nprocess\nprogramming\nrepo\nshell\nterminal\ntest\ntrigger\nworkflow",
          vi: "bash\ncong cu\ncông cụ\ndong lenh\ndòng lệnh\ngo\ngỡ\nhanh dong\nhành động\nkho ma\nkho mã\nkich hoat\nkiểm thử\nlap trinh\nlập trình\nma\nmã\nquan ly\nquản lý\nquy trinh\nquy trình\nshell\ntao\ntạo\nterminal\ntiến trình\ntu dong hoa\ntự động hóa\nyeu cau\nyêu cầu",
          "zh-CN":
            "Bash\n仓库\n代码\n创建\n命令行\n定时\n实现\n工作流\n工具\n操作\n标准输出\n测试\n监控\n移除\n管理\n终端\n编程\n自动化\n触发器\n请求\n调试\n进程",
        },
      },
    },
    write: {
      request: {
        base: "complete\ncomplete replacement\ncomplete text\ncontent\ncreate\ncreate file\nedit\nedit existing\nexisting\nexisting files\nfile\nfile complete\nfiles\nfiles replacing\noverwrite\nprefer\nprefer edit\nreplacement\nreplacement content\nreplacing\nrequires\ntext\ntrue\ntrue complete\nwrite",
        locales: {
          es: "accion\narchivo\narchivo completar\ncompletar\ncontenido\ncrear\ncrear archivo\neditar\nescribir\nherramienta\nsolicitud\nterminar",
          ko: "내용\n도구\n생성\n생성 파일\n쓰기\n완료\n요청\n작업\n콘텐츠\n파일\n파일 완료\n편집",
          pt: "acao\narquivo\narquivo concluir\ncompletar\nconcluir\nconteudo\ncriar\ncriar arquivo\neditar\nescrever\nferramenta\nsolicitacao",
          tl: "aksyon\nfile\nfile tapusin\ngumawa\ngumawa file\ni-edit\nisulat\nkahilingan\nkasangkapan\nnilalaman\ntapusin",
          vi: "chinh sua\nchỉnh sửa\ncong cu\ncông cụ\nhanh dong\nhành động\nhoan thanh\nhoàn thành\nnoi dung\nnội dung\ntao\ntạo\ntạo tệp\ntep\ntệp\ntệp hoàn thành\nviet\nviết\nyeu cau\nyêu cầu",
          "zh-CN":
            "内容\n写入\n创建\n创建 文件\n完成\n工具\n操作\n文件\n文件 完成\n编辑\n请求",
        },
      },
    },
    restart: {
      request: {
        base: "restart\nreboot\nreload\nrefresh\nrespawn",
        locales: {
          "zh-CN": "重启\n重开\n重新加载\n刷新",
          ko: "재시작\n다시 시작\n재부팅\n다시 불러와\n새로고침",
          es: "reinicia\nreiniciar\nreinicio\nrecarga\nrecargar\nrefresca\nrefrescar",
          pt: "reinicia\nreiniciar\nreinício\nreinicio\nrecarrega\nrecarregar\natualiza\natualizar",
          vi: "khởi động lại\nkhoi dong lai\ntải lại\ntai lai\nlàm mới\nlam moi",
          tl: "i-restart\nrestart\ni-reboot\ni-reload\ni-refresh",
        },
      },
    },
    setUserName: {
      recentContext: {
        base: "name\nmy name is\nmy name\ni'm\ni am\ncall me\ncall me by\nchange my name\nrename me",
        locales: {
          "zh-CN": "名字\n我的名字\n我叫\n我是\n叫我\n称呼我\n改名字",
          ko: "이름\n내 이름\n제 이름은\n나는\n불러줘\n라고 불러\n이름 바꿔",
          es: "nombre\nmi nombre\nmi nombre es\nme llamo\nllámame\nllamame\ncambia mi nombre",
          pt: "nome\nmeu nome\nmeu nome é\nmeu nome e\nme chamo\nme chama de\nchame-me\nmuda meu nome",
          vi: "tên\nten\ntên tôi\nten toi\ntôi là\ntoi la\ngọi tôi là\ngoi toi la\nđổi tên tôi\ndoi ten toi",
          tl: "pangalan\nang pangalan ko\nako si\ntawagin mo akong\npalitan ang pangalan ko",
        },
      },
    },
    manageTasks: {
      request: {
        base: "create task\nadd task\nnew task\nmake task\ncomplete task\nfinish task\ndone with task\nmark task done\ndelete task\nremove task\nupdate task\nedit task\nchange task\nlist tasks\nshow tasks\nmy tasks\nwhat are my tasks\nadd a todo\nadd a to-do\ncreate a to do\ntask list\ncheck off",
        locales: {
          "zh-CN":
            "创建任务\n添加任务\n新任务\n完成任务\n删除任务\n更新任务\n列出任务\n任务列表",
          ko: "작업 만들기\n작업 추가\n새 작업\n작업 완료\n작업 삭제\n작업 수정\n작업 목록",
          es: "crear tarea\nagregar tarea\nnueva tarea\ncompletar tarea\neliminar tarea\nactualizar tarea\nlistar tareas\nmis tareas\nlista de tareas",
          pt: "criar tarefa\nadicionar tarefa\nnova tarefa\nconcluir tarefa\nremover tarefa\natualizar tarefa\nlistar tarefas\nminhas tarefas\nlista de tarefas",
          vi: "tạo nhiệm vụ\ntao nhiem vu\nthêm nhiệm vụ\nthem nhiem vu\nhoàn thành nhiệm vụ\nhoan thanh nhiem vu\nxóa nhiệm vụ\nxoa nhiem vu\ncập nhật nhiệm vụ\ncap nhat nhiem vu\ndanh sách nhiệm vụ\ndanh sach nhiem vu",
          tl: "gumawa ng task\nmagdagdag ng task\nbagong task\ntapusin ang task\nburahin ang task\ni-update ang task\nlistahan ng task\nmga task ko",
        },
      },
    },
    appControl: {
      launchVerb: {
        base: "launch\nopen\nstart\nrun\nshow",
        locales: {
          "zh-CN": "启动\n打开\n运行\n开启\n显示",
          ko: "실행\n열어\n시작\n켜\n보여줘",
          es: "abre\nabrir\ninicia\niniciar\nejecuta\nmostrar",
          pt: "abre\nabrir\ninicia\niniciar\nexecuta\nmostrar",
          vi: "mở\nmo\nkhởi chạy\nkhoi chay\nchạy\nchay\nbắt đầu\nbat dau",
          tl: "buksan\nsimulan\npatakbuhin\nipakita",
        },
      },
      stopVerb: {
        base: "stop\nclose\nshut down\nkill\nquit\nexit",
        locales: {
          "zh-CN": "停止\n关闭\n关掉\n退出",
          ko: "중지\n멈춰\n종료\n닫아\n끄기",
          es: "detén\ndetener\ncierra\ncerrar\napaga\nsalir",
          pt: "parar\npare\nfechar\nfecha\ndesliga\nsair",
          vi: "dừng\ndung\ntắt\ntat\nđóng\ndong\nthoát\nthoat",
          tl: "ihinto\nitigil\nisara\npatayin\nlumabas",
        },
      },
      genericTarget: {
        base: "app\napplication",
        locales: {
          "zh-CN": "应用\n应用程序\n程序",
          ko: "앱\n애플리케이션",
          es: "app\naplicación\naplicacion\nprograma",
          pt: "app\naplicativo\naplicação\naplicacao\nprograma",
          vi: "ứng dụng\nung dung",
          tl: "app\naplikasyon\nprograma",
        },
      },
      knownApp: {
        base: "shopify\ncompanion\nfeed",
        locales: {
          "zh-CN": "shopify\ncompanion\nfeed",
          ko: "shopify\ncompanion\nfeed",
          es: "shopify\ncompanion\nfeed",
          pt: "shopify\ncompanion\nfeed",
          vi: "shopify\ncompanion\nfeed",
          tl: "shopify\ncompanion\nfeed",
        },
      },
    },
    terminal: {
      commandVerb: {
        base: "run\nexecute\nstart\ndo",
        locales: {
          "zh-CN": "运行\n执行\n开始",
          ko: "실행\n돌려\n시작\n해줘",
          es: "ejecuta\nejecutar\ncorre\ncorrer\ninicia",
          pt: "executa\nexecutar\nroda\nrodar\ninicia",
          vi: "chạy\nchay\nthực hiện\nthuc hien\nbắt đầu\nbat dau",
          tl: "patakbuhin\nisagawa\nsimulan\ngawin",
        },
      },
      commandFiller: {
        base: "command\nshell command\nterminal command",
        locales: {
          "zh-CN": "命令\n终端命令\nshell 命令",
          ko: "명령\n명령어\n터미널 명령",
          es: "comando\ncomando de terminal",
          pt: "comando\ncomando do terminal",
          vi: "lệnh\nlenh\nlệnh terminal\nlenh terminal",
          tl: "utos\ncommand\nutos sa terminal",
        },
      },
      utility: {
        base: "price\nworth\ncost\nbalance\nstatus\ncheck\ncurl\nfetch\ntail\nhead\nlog",
        locales: {
          "zh-CN": "价格\n余额\n状态\n检查\n日志",
          ko: "가격\n잔액\n상태\n확인\n로그",
          es: "precio\ncosto\nbalance\nsaldo\nestado\nrevisar\nlog",
          pt: "preço\npreco\ncusto\nsaldo\nestado\nverificar\nlog",
          vi: "giá\ngia\nsố dư\nso du\ntrạng thái\ntrang thai\nkiểm tra\nkiem tra\nlog",
          tl: "presyo\nbalanse\nstatus\ncheck\nlog",
        },
      },
      cryptoBitcoin: {
        base: "bitcoin\nbtc",
        locales: {
          "zh-CN": "比特币",
          ko: "비트코인",
          es: "bitcóin\nbitcoín\nbitcoin",
          pt: "bitcóin\nbitcoin",
          vi: "đồng bitcoin\ndong bitcoin\nbitcoin",
          tl: "bitcoin\nbarya ng bitcoin",
        },
      },
      cryptoEthereum: {
        base: "ethereum\neth",
        locales: {
          "zh-CN": "以太坊",
          ko: "이더리움",
          es: "ethereum\netéreo\netereo",
          pt: "ethereum\nether",
          vi: "ethereum\nđồng ethereum\ndong ethereum",
          tl: "ethereum\nether",
        },
      },
      cryptoSolana: {
        base: "solana\nsol",
        locales: {
          "zh-CN": "索拉纳",
          ko: "솔라나",
          es: "solana",
          pt: "solana",
          vi: "solana\nđồng solana\ndong solana",
          tl: "solana",
        },
      },
      disk: {
        base: "disk\nspace\nstorage\ndisk usage",
        locales: {
          "zh-CN": "磁盘\n空间\n存储",
          ko: "디스크\n저장공간\n저장소",
          es: "disco\nespacio\nalmacenamiento",
          pt: "disco\nespaço\nespaco\narmazenamento",
          vi: "ổ đĩa\no dia\ndung lượng\ndung luong\nlưu trữ\nluu tru",
          tl: "disk\nespasyo\nstorage",
        },
      },
      uptime: {
        base: "uptime\nload",
        locales: {
          "zh-CN": "运行时间\n负载",
          ko: "업타임\n부하",
          es: "tiempo activo\ncarga",
          pt: "uptime\ntempo ativo\ncarga",
          vi: "thời gian hoạt động\nthoi gian hoat dong\ntải\ntai",
          tl: "uptime\nload",
        },
      },
      memory: {
        base: "memory\nram",
        locales: {
          "zh-CN": "内存",
          ko: "메모리\n램",
          es: "memoria\nram",
          pt: "memória\nmemoria\nram",
          vi: "bộ nhớ\nbo nho\nram",
          tl: "memory\nram",
        },
      },
      process: {
        base: "process\nprocesses\ntop\nmemory usage",
        locales: {
          "zh-CN": "进程\n进程列表\n内存占用",
          ko: "프로세스\ntop\n메모리 사용",
          es: "proceso\nprocesos\ntop\nuso de memoria",
          pt: "processo\nprocessos\ntop\nuso de memória\nuso de memoria",
          vi: "tiến trình\ntien trinh\ntop\ndùng bộ nhớ\ndung bo nho",
          tl: "process\nmga proseso\ntop\ngamit ng memory",
        },
      },
    },
    logLevel: {
      command: {
        base: "/loglevel\nlog level\nlogging level",
        locales: {
          "zh-CN": "日志级别\n日志等级",
          ko: "로그 레벨\n로깅 레벨",
          es: "nivel de log\nnivel de registro",
          pt: "nível de log\nnivel de log\nnível de registro\nnivel de registro",
          vi: "mức log\nmuc log\nmức ghi log\nmuc ghi log",
          tl: "antas ng log\nantas ng pag-log",
        },
      },
      setVerb: {
        base: "set\nchange\nswitch",
        locales: {
          "zh-CN": "设置\n调成\n改成\n切换",
          ko: "설정\n바꿔\n변경\n전환",
          es: "pon\nponer\ncambia\ncambiar\najusta",
          pt: "define\ndefinir\nmuda\nmudar\najusta",
          vi: "đặt\ndat\nđổi\ndoi\nchuyển\nchuyen",
          tl: "itakda\npalitan\nilipat",
        },
      },
      domain: {
        base: "log\nlogging\nverbosity",
        locales: {
          "zh-CN": "日志\n详细程度",
          ko: "로그\n로깅\n상세도",
          es: "log\nregistro\nverbosidad",
          pt: "log\nregistro\nverbosidade",
          vi: "log\nghi log\nđộ chi tiết\ndo chi tiet",
          tl: "log\npag-log\nverbosity",
        },
      },
      level: {
        trace: {
          base: "trace",
          locales: {
            "zh-CN": "跟踪",
            ko: "추적",
            es: "rastreo",
            pt: "rastreamento",
            vi: "theo dõi\ntheo doi",
            tl: "bakas\ntrace",
          },
        },
        debug: {
          base: "debug",
          locales: {
            "zh-CN": "调试",
            ko: "디버그",
            es: "depuración\ndepuracion",
            pt: "depuração\ndepuracao",
            vi: "gỡ lỗi\ngo loi",
            tl: "debug\npag-debug",
          },
        },
        info: {
          base: "info\ninformation",
          locales: {
            "zh-CN": "信息",
            ko: "정보",
            es: "información\ninformacion",
            pt: "informação\ninformacao",
            vi: "thông tin\nthong tin",
            tl: "impormasyon",
          },
        },
        warn: {
          base: "warn\nwarning",
          locales: {
            "zh-CN": "警告",
            ko: "경고",
            es: "advertencia",
            pt: "aviso\nadvertência\nadvertencia",
            vi: "cảnh báo\ncanh bao",
            tl: "babala",
          },
        },
        error: {
          base: "error\nerrors",
          locales: {
            "zh-CN": "错误",
            ko: "오류",
            es: "error\nerrores",
            pt: "erro",
            vi: "lỗi\nloi",
            tl: "error\nmga error",
          },
        },
      },
    },
    updateRole: {
      intent: {
        base: "role\nassign role\nset role\nchange role\nupdate role\nboss\nmanager\nsupervisor\nsuperior\nlead\ncoworker\nco-worker\nteammate\ncolleague\npeer\nfriend\npartner\nadmin\nowner\nguest\nmember\nuser\nmod\nmoderator\npromote\ndemote\nrevoke\nremove role",
        locales: {
          "zh-CN":
            "角色\n分配角色\n设置角色\n修改角色\n老板\n经理\n主管\n上级\n负责人\n同事\n队友\n伙伴\n管理员\n所有者\n主人\n访客\n成员\n用户\n版主\n提升\n升级\n降级\n撤销\n移除角色",
          ko: "역할\n역할 설정\n역할 변경\n상사\n매니저\n관리자\n감독자\n리더\n동료\n팀원\n친구\n파트너\n오너\n소유자\n게스트\n멤버\n사용자\n모더레이터\n승급\n강등\n철회",
          es: "rol\nasigna el rol\ncambiar el rol\njefe\njefa\ngerente\nsupervisor\nlíder\nlider\ncompañero\ncompanero\ncolega\namigo\nsocio\nadministrador\ndueño\ndueno\npropietario\ninvitado\nmiembro\nusuario\nmoderador\nasciende\npromociona\ndegrada\nrevoca\nquitar el rol",
          pt: "papel\nfunção\nfuncao\ncargo\natribuir papel\nmudar papel\nchefe\ngerente\nsupervisor\nlíder\nlider\ncolega\namigo\nparceiro\nadministrador\ndono\nproprietário\nproprietario\nconvidado\nmembro\nusuário\nusuario\nmoderador\npromover\nrebaixar\nrevogar\nremover papel",
          vi: "vai trò\nvai tro\ngán vai trò\ngan vai tro\nđổi vai trò\ndoi vai tro\nsếp\nsep\nquản lý\nquan ly\ngiám sát\ngiam sat\ntrưởng nhóm\ntruong nhom\nđồng nghiệp\ndong nghiep\nbạn bè\nban be\nđối tác\ndoi tac\nquản trị viên\nquan tri vien\nchủ sở hữu\nchu so huu\nkhách\nthành viên\nthanh vien\nngười dùng\nnguoi dung\nđiều hành viên\ndieu hanh vien\nthăng cấp\nthang cap\nhạ cấp\nha cap\nthu hồi\nthu hoi",
          tl: "role\ntungkulin\nitakda ang role\nbaguhin ang role\nboss\nmanager\nsupervisor\nlead\nkatrabaho\nkasamahan\nkaibigan\npartner\nadmin\nmay-ari\nguest\nmiyembro\nuser\nmod\nmoderador\ni-promote\ni-demote\nbawiin\nalisin ang role",
        },
      },
    },
    triggerCreate: {
      request: {
        base: "schedule\nscheduled\ntrigger\nheartbeat\ncron\nrecurring\nrecur\nrepeat\nrepeating\nreminder\nremind\nautomate\nautomation\nautomatic\nperiodic\ninterval\nfollow up\ncheck in\nevery day\nevery week\nevery month\nevery hour\ndaily\nweekly\nmonthly\nhourly\nalarm\nwake me",
        locales: {
          "zh-CN":
            "安排\n定时\n触发器\n心跳\ncron\n循环\n重复\n提醒\n提醒我\n自动化\n自动\n定期\n间隔\n跟进\n检查一下\n每天\n每周\n每月\n每小时\n闹钟\n叫醒我",
          ko: "예약\n예약해\n트리거\n하트비트\n크론\n반복\n반복적으로\n알림\n리마인더\n자동화\n자동\n주기적\n간격\n후속 확인\n매일\n매주\n매달\n매시간\n알람\n깨워줘",
          es: "programa\nprogramar\nrecordatorio\nrecordar\nrecurrente\nrepetir\nautomatiza\nautomatizar\nautomático\nautomatico\nperiódico\nperiodico\nintervalo\nseguimiento\ncada día\ncada dia\ncada semana\ncada mes\ncada hora\ndiario\nsemanal\nmensual\nalarma\ndespiértame\ndespiertame",
          pt: "programa\nprogramar\nlembrete\nlembrar\nrecorrente\nrepetir\nautomatiza\nautomatizar\nautomático\nautomatico\nperiódico\nperiodico\nintervalo\nacompanhamento\ncada dia\ncada semana\ncada mês\ncada mes\ncada hora\ndiário\ndiario\nsemanal\nmensal\nalarme\nme acorde",
          vi: "lên lịch\nlen lich\nlời nhắc\nloi nhac\nnhắc tôi\nnhac toi\nlặp lại\nlap lai\ntự động\ntu dong\ntự động hóa\ntu dong hoa\nđịnh kỳ\ndinh ky\nkhoảng cách\nkhoang cach\ntheo dõi\ntheo doi\nmỗi ngày\nmoi ngay\nmỗi tuần\nmoi tuan\nmỗi tháng\nmoi thang\nmỗi giờ\nmoi gio\nbáo thức\nbao thuc\nđánh thức tôi\ndanh thuc toi",
          tl: "iskedyul\npaalala\nipaalala\npaulit-ulit\nulitin\nawtomatiko\nawtomasyon\npana-panahon\npagitan\nfollow up\nkada araw\nkada linggo\nkada buwan\nkada oras\nalarm\ngisingin mo ako",
        },
      },
    },
    createTask: {
      request: {
        base: "create task\ncreate trigger\ncreate a trigger\nset a trigger\nschedule a trigger\nschedule a task\nremind me\nreminder\nrecurring\nrepeat\nheartbeat\ncron\nrun every\nrun at\nevery day\nevery week\nevery month\nevery hour",
        locales: {
          "zh-CN":
            "创建任务\n创建触发器\n设置触发器\n安排任务\n提醒我\n提醒\n重复\n循环\n心跳\n定时\n每天\n每周\n每月\n每小时",
          ko: "작업 만들기\n트리거 만들기\n트리거 설정\n작업 예약\n알림\n리마인더\n반복\n하트비트\n크론\n매일\n매주\n매달\n매시간",
          es: "crear tarea\ncrear disparador\nprograma una tarea\nprograma un disparador\nrecordatorio\nrecuérdame\nrecurrente\nrepetir\ncada día\ncada dia\ncada semana\ncada mes\ncada hora",
          pt: "criar tarefa\ncriar gatilho\nprogramar tarefa\nprogramar gatilho\nlembrete\nlembra-me\nrecorrente\nrepetir\ncada dia\ncada semana\ncada mês\ncada mes\ncada hora",
          vi: "tạo tác vụ\ntao tac vu\ntạo trình kích hoạt\ntao trinh kich hoat\nlên lịch tác vụ\nlen lich tac vu\nlời nhắc\nloi nhac\nnhắc tôi\nnhac toi\nlặp lại\nlap lai\nmỗi ngày\nmoi ngay\nmỗi tuần\nmoi tuan",
          tl: "gumawa ng task\ngumawa ng trigger\niskedyul ang task\niskedyul ang trigger\npaalala\nipaalala\npaulit-ulit\nkada araw\nkada linggo\nkada buwan\nkada oras",
        },
      },
    },
    createPlan: {
      request: {
        base: "create plan\nmake a plan\nproject plan\ncomprehensive plan\norganize project\nstrategy\nstrategic plan",
        locales: {
          "zh-CN":
            "创建计划\n制定计划\n项目计划\n综合计划\n组织项目\n策略\n战略计划",
          ko: "계획 만들어\n계획 세워\n프로젝트 계획\n종합 계획\n프로젝트 정리\n전략\n전략 계획",
          es: "crear plan\nhacer un plan\nplan de proyecto\nplan integral\norganizar proyecto\nestrategia\nplan estratégico\nplan estrategico",
          pt: "criar plano\nfazer um plano\nplano de projeto\nplano abrangente\norganizar projeto\nestratégia\nestrategia\nplano estratégico\nplano estrategico",
          vi: "tạo kế hoạch\ntao ke hoach\nlập kế hoạch\nlap ke hoach\nkế hoạch dự án\nke hoach du an\nchiến lược\nchien luoc",
          tl: "gumawa ng plano\nplano ng proyekto\nkomprehensibong plano\nayusin ang proyekto\ndiskarte\nestratehiya",
        },
      },
    },
    searchContacts: {
      request: {
        base: "list contacts\nshow contacts\nsearch contacts\nfind contacts\nwho do i know\nfriends\ncolleagues\nvip",
        locales: {
          "zh-CN":
            "联系人列表\n显示联系人\n搜索联系人\n查找联系人\n我认识谁\n朋友\n同事\n贵宾",
          ko: "연락처 목록\n연락처 보여줘\n연락처 검색\n연락처 찾기\n내가 아는 사람\n친구\n동료\nVIP",
          es: "lista de contactos\nmuestra contactos\nbusca contactos\nencuentra contactos\na quién conozco\na quien conozco\namigos\ncolegas\nvip",
          pt: "lista de contatos\nmostrar contatos\nbuscar contatos\nencontrar contatos\nquem eu conheço\nquem eu conheco\namigos\ncolegas\nvip",
          vi: "danh sách liên hệ\ndanh sach lien he\nhiển thị liên hệ\nhien thi lien he\ntìm liên hệ\ntim lien he\ntôi quen ai\ntoi quen ai\nbạn bè\nban be\nđồng nghiệp\ndong nghiep",
          tl: "listahan ng contact\nipakita ang contact\nhanapin ang contact\nsino ang kilala ko\nkaibigan\nkasamahan\nvip",
        },
      },
    },
    addContact: {
      request: {
        base: "add contact\nsave contact\nremember contact\ncategorize contact\nadd to relationships\nsave this person",
        locales: {
          "zh-CN":
            "添加联系人\n保存联系人\n记住联系人\n给联系人分类\n加入关系\n保存这个人",
          ko: "연락처 추가\n연락처 저장\n연락처 기억해\n연락처 분류\n관계에 추가\n이 사람 저장",
          es: "agrega contacto\nagregar contacto\nguarda contacto\nrecuerda contacto\ncategoriza contacto\nagrega a relaciones\nguarda a esta persona",
          pt: "adicionar contato\nadiciona contato\nsalvar contato\nlembrar contato\ncategorizar contato\nadicionar aos relacionamentos\nsalvar esta pessoa",
          vi: "thêm liên hệ\nthem lien he\nlưu liên hệ\nluu lien he\nghi nhớ liên hệ\nghi nho lien he\nphân loại liên hệ\nphan loai lien he",
          tl: "magdagdag ng contact\ni-save ang contact\ntandaan ang contact\nikategorya ang contact\ni-save ang taong ito",
        },
      },
    },
    updateContact: {
      request: {
        base: "update contact\nedit contact\nmodify contact\nchange contact\nupdate relationship\nedit relationship\nchange notes\nadd tag\nremove tag\nadd category\nremove category",
        locales: {
          "zh-CN":
            "更新联系人\n编辑联系人\n修改联系人\n更新关系\n编辑关系\n修改备注\n添加标签\n移除标签\n添加分类\n移除分类",
          ko: "연락처 업데이트\n연락처 수정\n연락처 변경\n관계 업데이트\n메모 변경\n태그 추가\n태그 제거\n분류 추가\n분류 제거",
          es: "actualiza contacto\nactualizar contacto\nedita contacto\nmodifica contacto\ncambia contacto\nactualiza relación\nactualiza relacion\ncambia notas\nagrega etiqueta\nquita etiqueta\nagrega categoría\nagrega categoria\nquita categoría\nquita categoria",
          pt: "atualizar contato\natualiza contato\neditar contato\nmodificar contato\nmudar contato\natualizar relacionamento\nmudar notas\nadicionar etiqueta\nremover etiqueta\nadicionar categoria\nremover categoria",
          vi: "cập nhật liên hệ\ncap nhat lien he\nsửa liên hệ\nsua lien he\nthay đổi liên hệ\nthay doi lien he\ncập nhật quan hệ\ncap nhat quan he\nthêm thẻ\nthem the\nxóa thẻ\nxoa the",
          tl: "i-update ang contact\ni-edit ang contact\nbaguhin ang contact\ni-update ang relasyon\ndagdagan ng tag\nalisin ang tag\ndagdagan ng kategorya\nalisin ang kategorya",
        },
      },
    },
    removeContact: {
      request: {
        base: "remove contact\ndelete contact\ndrop contact\nremove from relationships\nforget contact",
        locales: {
          "zh-CN": "移除联系人\n删除联系人\n从关系中移除\n忘记联系人",
          ko: "연락처 제거\n연락처 삭제\n관계에서 제거\n연락처 잊어",
          es: "elimina contacto\neliminar contacto\nborra contacto\nquita de relaciones\nolvida contacto",
          pt: "remover contato\nexcluir contato\napagar contato\nremover dos relacionamentos\nesquecer contato",
          vi: "xóa liên hệ\nxoa lien he\ngỡ liên hệ\ngo lien he\nxóa khỏi quan hệ\nxoa khoi quan he",
          tl: "alisin ang contact\nburahin ang contact\ntanggalin sa relationships\nkalimutan ang contact",
        },
      },
    },
    scheduleFollowUp: {
      request: {
        base: "follow up\nfollowup\nremind me\ncheck in\ncheck back\nreach out\nschedule follow-up\nschedule a reminder",
        locales: {
          "zh-CN": "跟进\n提醒我\n回访\n联系一下\n安排提醒\n安排跟进",
          ko: "후속 조치\n팔로업\n알려줘\n체크인\n다시 연락\n후속 일정 잡아",
          es: "seguimiento\nhaz seguimiento\nrecuérdame\nrecuerdame\nvuelve a contactar\nrevisa de nuevo\nprograma seguimiento",
          pt: "acompanhamento\nfaça acompanhamento\nfaca acompanhamento\nlembra-me\nentre em contato de novo\nprograme acompanhamento",
          vi: "theo dõi\ntheo doi\nnhắc tôi\nnhac toi\nliên hệ lại\nlien he lai\nlên lịch theo dõi\nlen lich theo doi",
          tl: "follow up\npaalalahanan mo ako\ncheck in\nmakipag-ugnayan muli\niskedyul ang follow up",
        },
      },
    },
    followRoom: {
      request: {
        base: "follow this room\nparticipate here\nengage here\nlisten to this room\njoin this room\ntake interest",
        locales: {
          "zh-CN": "关注这个房间\n参与这里\n加入这个房间\n听这个房间",
          ko: "이 방을 팔로우해\n여기에 참여해\n이 방에 들어와\n이 방을 들어줘",
          es: "sigue esta sala\nparticipa aquí\nparticipa aqui\núnete a esta sala\nunete a esta sala\npresta atención aquí\npresta atencion aqui",
          pt: "siga esta sala\nparticipe aqui\nentre nesta sala\npreste atenção aqui\npreste atencao aqui",
          vi: "theo dõi phòng này\ntheo doi phong nay\ntham gia ở đây\ntham gia o day\nvào phòng này\nvao phong nay",
          tl: "i-follow ang room na ito\nsumali dito\nmakilahok dito\nmakinig sa room na ito",
        },
      },
    },
    muteRoom: {
      request: {
        base: "mute\nsilence\nquiet\nshut up\nstop talking\nbe quiet\nhush\nshh\nno more",
        locales: {
          "zh-CN": "静音\n安静\n闭嘴\n别说话\n不要再说了",
          ko: "음소거\n조용히\n입 다물어\n말하지 마\n그만 말해",
          es: "silencia\nponte en silencio\ncállate\ncallate\ndeja de hablar\nguarda silencio",
          pt: "silencia\nfique em silêncio\nfique em silencio\ncala a boca\npara de falar\nfique quieto",
          vi: "tắt tiếng\ntat tieng\nim lặng\nim lang\nđừng nói nữa\ndung noi nua",
          tl: "i-mute\ntumahimik\ntigilan ang pagsasalita\nwag ka nang magsalita",
        },
      },
    },
    unmuteRoom: {
      request: {
        base: "unmute\nunsilence\nlisten again\nstart talking\ntalk again\nspeak again\nenable\nresume",
        locales: {
          "zh-CN": "取消静音\n恢复说话\n再说话\n继续\n恢复",
          ko: "음소거 해제\n다시 말해\n다시 듣기\n재개",
          es: "activa el sonido\nquitar silencio\nvuelve a hablar\nreanuda\nescucha otra vez",
          pt: "tirar do silêncio\ntirar do silencio\nvolte a falar\nretomar\nouça de novo\nouca de novo",
          vi: "bỏ tắt tiếng\nbo tat tieng\nnói lại đi\nnoi lai di\ntiếp tục\ntiep tuc",
          tl: "i-unmute\nmagsalita ulit\nipagpatuloy\nmakinig ulit",
        },
      },
    },
    sendToAdmin: {
      request: {
        base: "admin\nuser\ntell admin\nnotify admin\ninform admin\nupdate admin\nmessage admin\nsend to admin\ncommunicate\nreport\nalert",
        locales: {
          "zh-CN":
            "管理员\n用户\n告诉管理员\n通知管理员\n向管理员汇报\n给管理员发消息\n警报",
          ko: "관리자\n사용자\n관리자에게 알려\n관리자에게 통지\n관리자에게 보고\n관리자에게 메시지 보내\n경고",
          es: "administrador\nusuario\navisa al administrador\ninforma al administrador\nmensaje al administrador\nenvía al administrador\nenvia al administrador\nalerta",
          pt: "administrador\nusuário\nusuario\navise o administrador\ninforme o administrador\nmensagem ao administrador\nenvie ao administrador\nalerta",
          vi: "quản trị viên\nquan tri vien\nngười dùng\nnguoi dung\nbáo quản trị viên\nbao quan tri vien\nnhắn quản trị viên\nnhan quan tri vien\ncảnh báo\ncanh bao",
          tl: "admin\nuser\nsabihin sa admin\nipaalam sa admin\ni-message ang admin\niulat\nalerto",
        },
      },
    },
    processDocuments: {
      request: {
        base: "process knowledge\nadd to knowledge\nupload document\nadd document\nlearn this\nremember this\nstore this\ningest file\nknowledge base",
        locales: {
          "zh-CN":
            "处理知识\n加入知识库\n上传文档\n添加文档\n记住这个\n存入知识库\n知识库",
          ko: "지식 처리\n지식에 추가\n문서 업로드\n문서 추가\n이걸 기억해\n저장해\n지식 베이스",
          es: "procesa conocimiento\nagrega al conocimiento\nsube documento\nañade documento\nanade documento\nrecuerda esto\nguarda esto\nbase de conocimiento",
          pt: "processar conhecimento\nadicionar ao conhecimento\nenviar documento\nadicionar documento\nlembre isto\nguarde isto\nbase de conhecimento",
          vi: "xử lý kiến thức\nxu ly kien thuc\nthêm vào kiến thức\nthem vao kien thuc\ntải tài liệu lên\ntai tai lieu len\nghi nhớ điều này\nghi nho dieu nay",
          tl: "iproseso ang kaalaman\nidagdag sa kaalaman\nmag-upload ng dokumento\ni-save ito\ntandaan ito\nknowledge base",
        },
      },
    },
    searchDocuments: {
      request: {
        base: "search knowledge\nfind information\nlook up\nquery knowledge base\nsearch documents\nfind in knowledge\nwhat do you know about",
        locales: {
          "zh-CN": "搜索知识\n查找信息\n查询知识库\n搜索文档\n你知道什么关于",
          ko: "지식 검색\n정보 찾기\n찾아봐\n지식 베이스 조회\n문서 검색\n무엇을 알고 있어",
          es: "busca conocimiento\nbuscar información\nbusca información\nbusca informacion\nconsulta la base de conocimiento\nbusca documentos\nqué sabes sobre\nque sabes sobre",
          pt: "busca conhecimento\nbuscar informação\nbuscar informacao\nprocure informação\nprocure informacao\nconsulte a base de conhecimento\no que você sabe sobre\no que voce sabe sobre",
          vi: "tìm kiến thức\ntim kien thuc\ntìm thông tin\ntim thong tin\ntra cứu kiến thức\ntra cuu kien thuc\nbạn biết gì về\nban biet gi ve",
          tl: "hanapin ang kaalaman\nhanapin ang impormasyon\ntingnan sa knowledge base\nano ang alam mo tungkol sa",
        },
      },
    },
    generateImage: {
      strong: {
        base: "generate image\ncreate image\nmake image\ndraw\npaint\nillustration\ngenerate picture\ncreate picture\nmake picture\ngenerate art\ncreate art\nimage of\npicture of\nphoto of",
        locales: {
          "zh-CN": "生成图片\n创建图片\n画\n绘制\n插画\n图片\n照片",
          ko: "이미지 생성\n그림 그려\n그려줘\n그림\n일러스트\n사진",
          es: "genera imagen\ncrear imagen\nhaz una imagen\ndibuja\npinta\nilustración\nilustracion\nfoto de",
          pt: "gerar imagem\ncriar imagem\nfaça uma imagem\nfaca uma imagem\ndesenhe\npinte\nilustração\nilustracao\nfoto de",
          vi: "tạo ảnh\ntao anh\nvẽ\nve\nminh họa\nminh hoa\nhình ảnh\nhinh anh",
          tl: "gumawa ng larawan\nlumikha ng larawan\ngumuhit\npinta\nlarawan ng\nphoto ng",
        },
      },
      weak: {
        base: "image\npicture\nvisual\nart\ngraphic\nrender\ngenerate\ncreate\ndesign\nsketch\nportrait",
        locales: {
          "zh-CN": "图片\n图像\n视觉\n艺术\n设计\n素描\n肖像",
          ko: "이미지\n사진\n비주얼\n아트\n디자인\n스케치\n초상화",
          es: "imagen\nfoto\nvisual\narte\ngráfico\ngrafico\ndiseño\ndiseno\nboceto\nretrato",
          pt: "imagem\nfoto\nvisual\narte\ngráfico\ngrafico\ndesign\nesboço\nesboco\nretrato",
          vi: "ảnh\nanh\nhình\nhinh\nthị giác\nthi giac\nnghệ thuật\nnghe thuat\nthiết kế\nthiet ke",
          tl: "larawan\nbiswal\nsining\ndisenyo\nsketch\nretrato",
        },
      },
    },
  },
  contextSignal: {
    admin: {
      strong: {
        base: "admin\nowner\npermissions\nroles\npolicy\nsystem control",
        locales: {
          es: "administrador\ndueño\npermisos\nroles\npolitica",
          ko: "관리자\n소유자\n권한\n역할\n정책",
          pt: "administrador\ndono\npermissoes\nfuncoes\npolitica",
          tl: "admin\nmay ari\npahintulot\nrole\npatakaran",
          vi: "quản trị\nquan tri\nchủ sở hữu\nchu so huu\nquyền\nquyen",
          "zh-CN": "管理员\n所有者\n权限\n角色\n策略",
        },
      },
    },
    agent_internal: {
      strong: {
        base: "agent internal\nself management\nautonomous task\ninternal state",
        locales: {
          es: "interno del agente\ngestion interna\nestado interno",
          ko: "에이전트 내부\n자체 관리\n내부 상태",
          pt: "interno do agente\ngestao interna\nestado interno",
          tl: "internal ng agent\nsariling pamamahala\ninternal state",
          vi: "nội bộ tác tử\nnoi bo tac tu\ntự quản lý\ntu quan ly",
          "zh-CN": "代理内部\n自我管理\n内部状态",
        },
      },
    },
    automation: {
      strong: {
        base: "automation\nworkflow\ntrigger\ncron\nmonitor\nscheduled job",
        locales: {
          es: "automatizacion\nflujo de trabajo\ndisparador\ncron\nmonitor",
          ko: "자동화\n워크플로\n트리거\n크론\n모니터",
          pt: "automacao\nfluxo de trabalho\ngatilho\ncron\nmonitor",
          tl: "automation\nworkflow\ntrigger\ncron\nmonitor",
          vi: "tự động hóa\ntu dong hoa\nquy trình\nquy trinh\nkich hoat",
          "zh-CN": "自动化\n工作流\n触发器\n定时\n监控",
        },
      },
    },
    browser: {
      strong: {
        base: "browser\nopen page\nclick\ntype on website\nbrowser session",
        locales: {
          es: "navegador\nabrir pagina\nhacer clic\nsitio web",
          ko: "브라우저\n페이지 열기\n클릭\n웹사이트 입력",
          pt: "navegador\nabrir pagina\nclicar\nsite",
          tl: "browser\nbuksan ang pahina\nclick\nwebsite",
          vi: "trình duyệt\ntrinh duyet\nmở trang\nmo trang\nnhấp",
          "zh-CN": "浏览器\n打开页面\n点击\n网站输入",
        },
      },
    },
    character: {
      strong: {
        base: "character\npersonality\nvoice\nstyle\nsystem prompt\nagent profile",
        locales: {
          es: "personaje\npersonalidad\nvoz\nestilo\nperfil",
          ko: "캐릭터\n성격\n목소리\n스타일\n프로필",
          pt: "personagem\npersonalidade\nvoz\nestilo\nperfil",
          tl: "karakter\npersonalidad\nboses\nestilo\nprofile",
          vi: "nhân vật\nnhan vat\ntính cách\ntinh cach\ngiọng\ngiong",
          "zh-CN": "角色\n性格\n声音\n风格\n资料",
        },
      },
    },
    code: {
      strong: {
        base: "code\nprogramming\nrepo\nrepository\nimplementation\ndebug\ntest",
        locales: {
          es: "codigo\nprogramacion\nrepositorio\nimplementar\ndepurar\nprueba",
          ko: "코드\n프로그래밍\n저장소\n구현\n디버그\n테스트",
          pt: "codigo\nprogramacao\nrepositorio\nimplementar\ndepurar\nteste",
          tl: "code\nprogramming\nrepo\nipatupad\ndebug\ntest",
          vi: "mã\nma\nlập trình\nlap trinh\nkho mã\nkho ma\nkiểm thử",
          "zh-CN": "代码\n编程\n仓库\n实现\n调试\n测试",
        },
      },
    },
    connectors: {
      strong: {
        base: "connector\nintegration\noauth\nmcp\naccount connection\napp auth",
        locales: {
          es: "conector\nintegracion\noauth\nmcp\ncuenta conectada",
          ko: "커넥터\n통합\n오어스\n계정 연결",
          pt: "conector\nintegracao\noauth\nmcp\nconta conectada",
          tl: "connector\nintegration\noauth\naccount connection",
          vi: "kết nối\nket noi\ntích hợp\ntich hop\noauth\ntài khoản",
          "zh-CN": "连接器\n集成\n授权\n账号连接",
        },
      },
    },
    contacts: {
      strong: {
        base: "contacts\nperson\npeople\nrelationship\nfriend\ncolleague",
        locales: {
          es: "contactos\npersona\ngente\nrelacion\namigo\ncolega",
          ko: "연락처\n사람\n관계\n친구\n동료",
          pt: "contatos\npessoa\npessoas\nrelacao\namigo\ncolega",
          tl: "contacts\ntao\nrelasyon\nkaibigan\nkasamahan",
          vi: "liên hệ\nlien he\nngười\nnguoi\nquan hệ\nquan he",
          "zh-CN": "联系人\n人物\n关系\n朋友\n同事",
        },
      },
    },
    crypto: {
      strong: {
        base: "crypto\ntoken\ndefi\non-chain\nswap\nbridge\nliquidity",
        locales: {
          es: "cripto\ntoken\ndefi\ncadena\nintercambio\nliquidez",
          ko: "암호화폐\n토큰\n디파이\n온체인\n스왑\n유동성",
          pt: "cripto\ntoken\ndefi\nonchain\ntroca\nliquidez",
          tl: "crypto\ntoken\ndefi\nswap\nliquidity",
          vi: "crypto\ntiền mã hóa\ntien ma hoa\ntoken\ndefi\nthanh khoản",
          "zh-CN": "加密货币\n代币\n链上\n交换\n流动性",
        },
      },
    },
    documents: {
      strong: {
        base: "document\ndocuments\nnotes\nfile content\nsave notes\nartifact",
        locales: {
          es: "documento\ndocumentos\nnotas\nguardar notas\narchivo",
          ko: "문서\n노트\n파일 내용\n저장",
          pt: "documento\ndocumentos\nnotas\nsalvar notas\narquivo",
          tl: "dokumento\nnotes\nnilalaman ng file\ni-save",
          vi: "tài liệu\ntai lieu\nghi chú\nghi chu\nlưu ghi chú",
          "zh-CN": "文档\n笔记\n文件内容\n保存笔记",
        },
      },
    },
    email: {
      strong: {
        base: "email account\nmail\ninbox\ndraft email\nsend email",
        locales: {
          es: "correo\nbandeja\nredactar correo\nenviar correo",
          ko: "이메일\n메일함\n받은편지함\n메일 보내기",
          pt: "email\ncorreio\ncaixa de entrada\nenviar email",
          tl: "email\ninbox\ngumawa ng email\nmagpadala ng email",
          vi: "email\nthư\nthu\nhộp thư\nhop thu\ngửi email",
          "zh-CN": "邮件\n邮箱\n收件箱\n发送邮件",
        },
      },
    },
    files: {
      strong: {
        base: "file\nfiles\nfolder\ndirectory\nread file\nwrite file",
        locales: {
          es: "archivo\narchivos\ncarpeta\ndirectorio\nleer archivo",
          ko: "파일\n폴더\n디렉터리\n파일 읽기\n파일 쓰기",
          pt: "arquivo\narquivos\npasta\ndiretorio\nler arquivo",
          tl: "file\nfiles\nfolder\ndirectory\nbasahin file",
          vi: "tệp\ntep\nthư mục\nthu muc\nđọc tệp\ndoc tep",
          "zh-CN": "文件\n文件夹\n目录\n读取文件\n写文件",
        },
      },
    },
    finance: {
      strong: {
        base: "finance\nmoney\nbalance\nportfolio\ninvoice\naccount",
        locales: {
          es: "finanzas\ndinero\nsaldo\nportafolio\nfactura\ncuenta",
          ko: "금융\n돈\n잔액\n포트폴리오\n청구서\n계정",
          pt: "financas\ndinheiro\nsaldo\nportfolio\nfatura\nconta",
          tl: "finance\npera\nbalance\nportfolio\ninvoice\naccount",
          vi: "tài chính\ntai chinh\ntiền\ntien\nsố dư\nso du",
          "zh-CN": "财务\n钱\n余额\n投资组合\n发票\n账户",
        },
      },
    },
    game: {
      strong: {
        base: "game\ngameplay\nmatch\nsimulation\nplayer\nturn",
        locales: {
          es: "juego\npartida\nsimulacion\njugador\nturno",
          ko: "게임\n플레이\n매치\n시뮬레이션\n플레이어\n턴",
          pt: "jogo\npartida\nsimulacao\njogador\nturno",
          tl: "laro\ngameplay\nsimulation\nplayer\nturn",
          vi: "trò chơi\ntro choi\nmô phỏng\nmo phong\nngười chơi",
          "zh-CN": "游戏\n对局\n模拟\n玩家\n回合",
        },
      },
    },
    general: {
      strong: {
        base: "general chat\nconversation\nreply\nanswer\ntalk",
        locales: {
          es: "conversacion\nrespuesta\nhablar\nchat general",
          ko: "일반 대화\n답변\n말하기\n채팅",
          pt: "conversa\nresposta\nfalar\nchat geral",
          tl: "usap\nsagot\nmakipag-usap\ngeneral chat",
          vi: "trò chuyện\ntro chuyen\ntrả lời\ntra loi\nnói chuyện",
          "zh-CN": "普通聊天\n对话\n回复\n回答",
        },
      },
    },
    health: {
      strong: {
        base: "health\nwellness\nsleep\nexercise\nmedicine\nsymptom",
        locales: {
          es: "salud\nbienestar\nsueño\nejercicio\nmedicina\nsintoma",
          ko: "건강\n웰니스\n수면\n운동\n약\n증상",
          pt: "saude\nbem-estar\nsono\nexercicio\nremedio\nsintoma",
          tl: "kalusugan\nwellness\ntulog\nehersisyo\ngamot\nsintomas",
          vi: "sức khỏe\nsuc khoe\nngủ\nngu\ntập luyện\ntrieu chung",
          "zh-CN": "健康\n睡眠\n运动\n药物\n症状",
        },
      },
    },
    knowledge: {
      strong: {
        base: "knowledge\nknown facts\nsaved notes\nrecall\nsemantic search",
        locales: {
          es: "conocimiento\nhechos guardados\nnotas guardadas\nrecordar",
          ko: "지식\n저장된 사실\n저장된 노트\n회상\n검색",
          pt: "conhecimento\nfatos salvos\nnotas salvas\nlembrar",
          tl: "kaalaman\nsaved facts\nsaved notes\nalalahanin",
          vi: "kiến thức\nkien thuc\nghi chú đã lưu\nghi chu da luu\nnhớ lại",
          "zh-CN": "知识\n已保存事实\n已保存笔记\n回忆\n语义搜索",
        },
      },
    },
    media: {
      strong: {
        base: "media\nimage\nvideo\naudio\nscreenshot\ntranscript",
        locales: {
          es: "multimedia\nimagen\nvideo\naudio\ncaptura\ntranscripcion",
          ko: "미디어\n이미지\n비디오\n오디오\n스크린샷\n전사",
          pt: "midia\nimagem\nvideo\naudio\ncaptura\ntranscricao",
          tl: "media\nlarawan\nvideo\naudio\nscreenshot\ntranscript",
          vi: "đa phương tiện\nda phuong tien\nhình ảnh\nhinh anh\nvideo\nâm thanh",
          "zh-CN": "媒体\n图片\n视频\n音频\n截图\n转录",
        },
      },
    },
    memory: {
      strong: {
        base: "memory\nremember\nrecall\nsave memory\nlong term memory",
        locales: {
          es: "memoria\nrecordar\nrecuerdo\nguardar memoria",
          ko: "기억\n기억해\n회상\n장기 기억",
          pt: "memoria\nlembrar\nrecordar\nsalvar memoria",
          tl: "memory\ntandaan\nalalahanin\nlong term memory",
          vi: "ký ức\nky uc\nnhớ\nnho\nghi nhớ\nghi nho",
          "zh-CN": "记忆\n记住\n回忆\n长期记忆",
        },
      },
    },
    payments: {
      strong: {
        base: "payment\npay\ninvoice\nbilling\ncheckout\nsubscription charge",
        locales: {
          es: "pago\npagar\nfactura\ncobro\ncheckout",
          ko: "결제\n지불\n청구서\n요금\n체크아웃",
          pt: "pagamento\npagar\nfatura\ncobranca\ncheckout",
          tl: "bayad\nmagbayad\ninvoice\nbilling\ncheckout",
          vi: "thanh toán\nthanh toan\nhóa đơn\nhoa don\ntính tiền",
          "zh-CN": "付款\n支付\n发票\n账单\n结账",
        },
      },
    },
    phone: {
      strong: {
        base: "phone\nsms\ntext message\ncall\ndial\niMessage",
        locales: {
          es: "telefono\nsms\nmensaje\nllamada\nmarcar",
          ko: "전화\n문자\n메시지\n통화\n아이메시지",
          pt: "telefone\nsms\nmensagem\nligacao\ndiscar",
          tl: "telepono\nsms\ntext\ntawag\ndial",
          vi: "điện thoại\ndien thoai\nsms\ntin nhắn\ncuộc gọi",
          "zh-CN": "电话\n短信\n消息\n通话\n拨号",
        },
      },
    },
    productivity: {
      strong: {
        base: "productivity\nplanning\npriorities\nwork planning\npersonal operations",
        locales: {
          es: "productividad\nplanificacion\nprioridades\nplan de trabajo",
          ko: "생산성\n계획\n우선순위\n업무 계획",
          pt: "produtividade\nplanejamento\nprioridades\nplano de trabalho",
          tl: "productivity\npagpaplano\nprayoridad\nwork plan",
          vi: "năng suất\nnang suat\nlập kế hoạch\nlap ke hoach\nưu tiên",
          "zh-CN": "效率\n规划\n优先级\n工作计划",
        },
      },
    },
    research: {
      strong: {
        base: "research\ninvestigate\ncompare sources\nfindings\ncitations\nsynthesis",
        locales: {
          es: "investigacion\ninvestigar\ncomparar fuentes\nhallazgos\ncitas",
          ko: "조사\n연구\n출처 비교\n결과\n인용\n종합",
          pt: "pesquisa\ninvestigar\ncomparar fontes\nachados\ncitacoes",
          tl: "research\nimbestiga\nikumpara sources\nfindings\ncitations",
          vi: "nghiên cứu\nnghien cuu\nđiều tra\ndieu tra\ntrích dẫn",
          "zh-CN": "研究\n调查\n比较来源\n发现\n引用\n综合",
        },
      },
    },
    screen_time: {
      strong: {
        base: "screen time\ndevice usage\napp limits\nusage report\nfocus",
        locales: {
          es: "tiempo de pantalla\nuso del dispositivo\nlimites de apps\nenfoque",
          ko: "스크린 타임\n기기 사용\n앱 제한\n사용 보고서\n집중",
          pt: "tempo de tela\nuso do dispositivo\nlimites de app\nfoco",
          tl: "screen time\ngamit ng device\napp limits\nfocus",
          vi: "thời gian màn hình\nthoi gian man hinh\ngiới hạn ứng dụng",
          "zh-CN": "屏幕时间\n设备使用\n应用限制\n使用报告\n专注",
        },
      },
    },
    secrets: {
      strong: {
        base: "secret\nsecrets\napi key\ntoken\ncredential\npassword",
        locales: {
          es: "secreto\nsecretos\nclave api\ntoken\ncredencial\ncontraseña",
          ko: "비밀\n시크릿\napi 키\n토큰\n자격 증명\n비밀번호",
          pt: "segredo\nsegredos\nchave api\ntoken\ncredencial\nsenha",
          tl: "secret\napi key\ntoken\ncredential\npassword",
          vi: "bí mật\nbi mat\nkhóa api\nkhoa api\ntoken\nmật khẩu",
          "zh-CN": "密钥\n秘密\nAPI 密钥\n令牌\n凭据\n密码",
        },
      },
    },
    settings: {
      strong: {
        base: "settings\npreferences\nconfiguration\nconfig\ntoggle\nmodel settings",
        locales: {
          es: "ajustes\npreferencias\nconfiguracion\nactivar\nmodelo",
          ko: "설정\n환경설정\n구성\n토글\n모델 설정",
          pt: "configuracoes\npreferencias\nconfiguracao\nalternar\nmodelo",
          tl: "settings\npreferences\nconfiguration\ntoggle\nmodel settings",
          vi: "cài đặt\ncai dat\ntùy chọn\ntuy chon\ncấu hình",
          "zh-CN": "设置\n偏好\n配置\n开关\n模型设置",
        },
      },
    },
    simple: {
      strong: {
        base: "simple answer\nno tools\ndirect reply\njust answer",
        locales: {
          es: "respuesta simple\nsin herramientas\nrespuesta directa",
          ko: "간단한 답\n도구 없음\n직접 답변",
          pt: "resposta simples\nsem ferramentas\nresposta direta",
          tl: "simpleng sagot\nwalang tools\ndirektang sagot",
          vi: "trả lời đơn giản\ntra loi don gian\nkhông dùng công cụ",
          "zh-CN": "简单回答\n不用工具\n直接回复",
        },
      },
    },
    social: {
      strong: {
        base: "social\nsocial media\nfeed\ntimeline\ndm\nreply",
        locales: {
          es: "social\nredes sociales\nfeed\nlinea de tiempo\ndm\nresponder",
          ko: "소셜\n소셜 미디어\n피드\n타임라인\n디엠\n답글",
          pt: "social\nrede social\nfeed\nlinha do tempo\ndm\nresponder",
          tl: "social\nsocial media\nfeed\ntimeline\ndm\nreply",
          vi: "mạng xã hội\nmang xa hoi\nbảng tin\nbang tin\ntin nhắn riêng",
          "zh-CN": "社交\n社交媒体\n动态\n时间线\n私信\n回复",
        },
      },
    },
    social_posting: {
      strong: {
        base: "post\npublish\ntweet\ntimeline\npublic reply\nfeed search",
        locales: {
          es: "publicar\npost\ntuit\nlinea de tiempo\nrespuesta publica",
          ko: "게시\n발행\n트윗\n타임라인\n공개 답글",
          pt: "postar\npublicar\ntweet\nlinha do tempo\nresposta publica",
          tl: "mag-post\npublish\ntweet\ntimeline\npublic reply",
          vi: "đăng\ndang\nxuất bản\nxuat ban\ntweet\ndòng thời gian",
          "zh-CN": "发布\n帖子\n推文\n时间线\n公开回复",
        },
      },
    },
    state: {
      strong: {
        base: "state\nstatus\ncurrent mode\nruntime state\nroom state",
        locales: {
          es: "estado\nestatus\nmodo actual\nestado de runtime",
          ko: "상태\n현재 모드\n런타임 상태\n룸 상태",
          pt: "estado\nstatus\nmodo atual\nestado do runtime",
          tl: "state\nstatus\ncurrent mode\nruntime state",
          vi: "trạng thái\ntrang thai\nchế độ hiện tại\nche do hien tai",
          "zh-CN": "状态\n当前模式\n运行时状态\n房间状态",
        },
      },
    },
    subscriptions: {
      strong: {
        base: "subscription\nrenewal\nrecurring service\nbilling cycle\nmembership",
        locales: {
          es: "suscripcion\nrenovacion\nservicio recurrente\nciclo de cobro",
          ko: "구독\n갱신\n반복 서비스\n결제 주기\n멤버십",
          pt: "assinatura\nrenovacao\nservico recorrente\nciclo de cobranca",
          tl: "subscription\nrenewal\nrecurring service\nbilling cycle",
          vi: "đăng ký\ndang ky\ngia hạn\ngia han\nchu kỳ thanh toán",
          "zh-CN": "订阅\n续费\n周期服务\n账单周期\n会员",
        },
      },
    },
    system: {
      strong: {
        base: "system\nruntime\ndiagnostics\nprocess\noperational command",
        locales: {
          es: "sistema\nruntime\ndiagnostico\nproceso\noperacion",
          ko: "시스템\n런타임\n진단\n프로세스\n운영 명령",
          pt: "sistema\nruntime\ndiagnostico\nprocesso\noperacao",
          tl: "system\nruntime\ndiagnostics\nprocess\noperation",
          vi: "hệ thống\nhe thong\nruntime\nchẩn đoán\nchan doan",
          "zh-CN": "系统\n运行时\n诊断\n进程\n运维命令",
        },
      },
    },
    tasks: {
      strong: {
        base: "task\ntasks\ntodo\nreminder\nfollow up\ndue date",
        locales: {
          es: "tarea\ntareas\npendiente\nrecordatorio\nseguimiento\nfecha limite",
          ko: "작업\n할 일\n리마인더\n후속 조치\n마감일",
          pt: "tarefa\ntarefas\nafazer\nlembrete\nacompanhamento\nprazo",
          tl: "task\ntodo\npaalala\nfollow up\ndeadline",
          vi: "tác vụ\ntac vu\nviệc cần làm\nviec can lam\nnhắc nhở",
          "zh-CN": "任务\n待办\n提醒\n跟进\n截止日期",
        },
      },
    },
    terminal: {
      strong: {
        base: "terminal\nshell\ncommand line\nbash\nprocess\nstdout",
        locales: {
          es: "terminal\nshell\nlinea de comandos\nbash\nproceso",
          ko: "터미널\n셸\n명령줄\n배시\n프로세스",
          pt: "terminal\nshell\nlinha de comando\nbash\nprocesso",
          tl: "terminal\nshell\ncommand line\nbash\nprocess",
          vi: "terminal\nshell\ndòng lệnh\ndong lenh\nbash\ntiến trình",
          "zh-CN": "终端\n命令行\nBash\n进程\n标准输出",
        },
      },
    },
    todos: {
      strong: {
        base: "todo\ntodos\ntask list\ncomplete task\ndelete task\nactive task",
        locales: {
          es: "pendiente\npendientes\nlista de tareas\ncompletar tarea\nborrar tarea",
          ko: "할 일\n작업 목록\n작업 완료\n작업 삭제\n활성 작업",
          pt: "afazer\nafazeres\nlista de tarefas\nconcluir tarefa\napagar tarefa",
          tl: "todo\ntask list\nkumpletuhin task\nburahin task",
          vi: "việc cần làm\nviec can lam\ndanh sách tác vụ\nhoàn thành tác vụ",
          "zh-CN": "待办\n任务列表\n完成任务\n删除任务\n活动任务",
        },
      },
    },
    wallet: {
      strong: {
        base: "wallet\nbalance\ntransfer\nsign transaction\naccount address\nportfolio",
        locales: {
          es: "billetera\nsaldo\ntransferir\nfirmar transaccion\ndireccion",
          ko: "지갑\n잔액\n전송\n거래 서명\n주소\n포트폴리오",
          pt: "carteira\nsaldo\ntransferir\nassinar transacao\nendereco",
          tl: "wallet\nbalance\ntransfer\nsign transaction\naddress",
          vi: "ví\nvi\nsố dư\nso du\nchuyển\nchuyen\nký giao dịch",
          "zh-CN": "钱包\n余额\n转账\n签名交易\n地址\n投资组合",
        },
      },
    },
    web: {
      strong: {
        base: "web\ninternet\ncurrent information\nsearch web\nopen url\nlatest\nprice\nworth\nhow much\nweather\nforecast\ntemperature\nexchange rate",
        locales: {
          es: "web\ninternet\ninformacion actual\nbuscar web\nabrir url\nultimo",
          ko: "웹\n인터넷\n최신 정보\n웹 검색\nurl 열기\n최신",
          pt: "web\ninternet\ninformacao atual\nbuscar na web\nabrir url",
          tl: "web\ninternet\nkasalukuyang impormasyon\nsearch web\nopen url",
          vi: "web\ninternet\nthông tin hiện tại\nthong tin hien tai\ntìm web",
          "zh-CN": "网络\n互联网\n最新信息\n网页搜索\n打开网址",
        },
      },
    },
    world: {
      strong: {
        base: "world\nserver\nroom\nchannel\nparticipants\nmembership",
        locales: {
          es: "mundo\nservidor\nsala\ncanal\nparticipantes\nmiembros",
          ko: "월드\n서버\n방\n채널\n참가자\n멤버십",
          pt: "mundo\nservidor\nsala\ncanal\nparticipantes\nmembros",
          tl: "world\nserver\nroom\nchannel\nparticipants\nmembership",
          vi: "thế giới\nthe gioi\nmáy chủ\nmay chu\nphòng\nkenh",
          "zh-CN": "世界\n服务器\n房间\n频道\n参与者\n成员",
        },
      },
    },
    gmail: {
      strong: {
        base: "email\nemails\ne-mail\ngmail\ninbox\nmailbox\ncompose\ndraft\ndrafts\nunread\nstarred\nmail\nmessage\nmessages\nrespond to\nreply to\ncheck my email\ncheck email\nnew mail\nshoot me an email",
        locales: {
          "zh-CN": "邮件\n电子邮件\n邮箱\n收件箱\n消息",
          ko: "이메일\n메일\n지메일\n받은편지함\n메시지\n메세지",
          es: "correo\ncorreos\ncorreo electronico\ncorreo electrónico\nbandeja de entrada\nmensaje\nmensajes",
          pt: "correio\ncorreios\ncorreio eletronico\ncorreio eletrônico\ncaixa de entrada\nmensagem\nmensagens",
          vi: "thư điện tử\nthu dien tu\nhộp thư\nhop thu\ntin nhắn",
          tl: "koreo\nliham\nmensahe",
        },
      },
      weak: {
        base: "send\nreply\nrespond\nsender\nsubject\nattach\nattachment\ncc\nbcc\nfrom\nforward\nimportant",
        locales: {
          "zh-CN": "发送\n回复\n发件人\n主题\n附件\n抄送\n转发\n重要",
          ko: "보내기\n답장\n보낸사람\n제목\n첨부\n참조\n전달\n중요",
          es: "enviar\nresponder\nremitente\nasunto\nadjunto\nadjuntar\nreenviar\nimportante",
          pt: "enviar\nresponder\nremetente\nassunto\nanexo\nanexar\nencaminhar\nimportante",
          vi: "gửi\ngui\ntrả lời\ntra loi\nngười gửi\nnguoi gui\nchủ đề\nchu de\nđính kèm\ndinh kem\nchuyển tiếp\nchuyen tiep",
          tl: "ipadala\nsagot\nnagpadala\npaksa\nkalakip\nipasa\nmahalaga",
        },
      },
    },
    calendar: {
      strong: {
        base: "calendar\nevent\nevents\nflight\nflights\nmeeting\nmeetings\nappointment\nappointments\ntrip\ntravel\nitinerary\nagenda\nschedule\nhotel\nhotels",
        locales: {
          "zh-CN":
            "日历\n行程\n事件\n活动\n航班\n会议\n约会\n旅行\n差旅\n酒店\n议程\n安排",
          ko: "캘린더\n일정\n이벤트\n항공편\n비행기\n미팅\n회의\n약속\n여행\n일정표\n호텔",
          es: "calendario\nevento\neventos\nvuelo\nvuelos\nreunion\nreunión\nreuniones\ncita\ncitas\nviaje\nitinerario\nagenda\nhorario\nhotel\nhoteles",
          pt: "calendario\nevento\neventos\nvoo\nvoos\nreuniao\nreunião\nreunioes\nreuniões\ncompromisso\ncompromissos\nviagem\nitinerario\nitinerário\nagenda\nhorario\nhorário\nhotel\nhoteis\nhotéis",
          vi: "lịch\nsự kiện\ncuộc họp\nchuyến bay\ndu lịch\nhành trình\nlịch trình\nkhách sạn",
          tl: "kalendaryo\nkaganapan\nlipad\npulong\nappointment\nbiyahe\nitinerary\niskedyul\nhotel",
        },
      },
      weak: {
        base: "time\nawake\nsleep\nearlier\nlater\nbook\nbooking\nbooked\ncheck\nfree\nbusy\nweek\nyesterday\ntoday\ntomorrow\ntonight\nmonth\nyear",
        locales: {
          "zh-CN":
            "时间\n早点\n晚点\n预订\n查看\n空闲\n忙\n周\n昨天\n今天\n明天\n今晚\n月\n年",
          ko: "시간\n일찍\n늦게\n예약\n확인\n한가해\n바빠\n주\n어제\n오늘\n내일\n오늘밤\n달\n년",
          es: "hora\ntemprano\ntarde\nreservar\nreserva\nlibre\nocupado\nsemana\nayer\nhoy\nmanana\nmañana\nnoche\nmes\nano\naño",
          pt: "hora\ncedo\ntarde\nreservar\nreserva\nlivre\nocupado\nsemana\nontem\nhoje\namanha\namanhã\nnoite\nmes\nmês\nano",
          vi: "giờ\nsớm\nmuộn\nđặt\nrảnh\nbận\ntuần\nhôm qua\nhôm nay\nngày mai\ntối nay\ntháng\nnăm",
          tl: "oras\nmaaga\nmamaya\nreserba\nlibre\nabala\nlinggo\nkahapon\nngayon\nbukas\ngabi\nbuwan\ntaon",
        },
      },
    },
    web_search: {
      strong: {
        base: "search\ngoogle\nlook up\nlook it up\nweb search\nsearch the web\nsearch online\nsearch for\nfind out\nbrowse for",
        locales: {
          "zh-CN": "搜索\n查一下\n查一查\n上网查\n网页搜索\n谷歌\ngoogle\n百度",
          ko: "검색\n찾아봐\n찾아봐줘\n웹 검색\n구글\ngoogle",
          es: "buscar\nbusca\ngooglea\ngooglear\nbusca en la web\nbusca en internet\ninvestiga",
          pt: "buscar\npesquisa\npesquise\ngoogle\nprocura na web\nprocura online",
          vi: "tìm\ntìm kiếm\ntra cứu\ntra cuu\ngoogle\ntìm trên web",
          tl: "hanapin\nmaghanap\ni-google\ngoogle\nhanap sa web",
        },
      },
      weak: {
        base: "what is\nwho is\nwhen did\nlatest\nrecent\nnews\ncurrent\ntoday\nhow much\nprice of\nwhere is\nfind\nresearch\ncheck",
        locales: {
          "zh-CN": "最新\n最近\n新闻\n当前\n今天\n价格\n研究\n查",
          ko: "최신\n최근\n뉴스\n현재\n오늘\n가격\n조사\n확인",
          es: "ultimo\núltima\nreciente\nnoticias\nactual\nhoy\nprecio\ninvestigar\nrevisar",
          pt: "ultimo\núltimo\nrecente\nnoticias\nnotícias\natual\nhoje\npreço\npreco\npesquisar\nconferir",
          vi: "mới nhất\ngần đây\ntin tức\nhiện tại\nhôm nay\ngiá\nnghiên cứu\nkiểm tra",
          tl: "pinakabago\nkamakailan\nbalita\nkasalukuyan\nngayon\npresyo\nresearch\ncheck",
        },
      },
    },
    send_message: {
      strong: {
        base: "send message\nsend a message\ndm\ndirect message\nnotify\nalert\ntell them\nmessage them\nreach out\npost to\npost in",
        locales: {
          "zh-CN": "发消息\n发送消息\n私信\n通知\n提醒",
          ko: "메시지 보내\n메세지 보내\n쪽지\n디엠\ndm\n알려줘\n전달해",
          es: "enviar mensaje\nmanda mensaje\nmensaje directo\ndm\nnotifica\navisa",
          pt: "enviar mensagem\nmanda mensagem\nmensagem direta\ndm\nnotifica\navisa",
          vi: "gửi tin nhắn\ngui tin nhan\nnhắn tin\ndm\nthông báo\nnhắc",
          tl: "magpadala ng mensahe\npadalhan ng mensahe\ndm\ndirektang mensahe\nabisuhan",
        },
      },
      weak: {
        base: "send\nmessage\ntell\nnotify\nalert\nadmin\nowner\nurgent\nescalate\nchannel\nroom",
        locales: {
          "zh-CN": "发送\n消息\n通知\n提醒\n管理员\nowner\n紧急\n频道\n房间",
          ko: "보내\n메시지\n알림\n관리자\nowner\n긴급\n채널\n방",
          es: "enviar\nmensaje\navisar\nnotificar\nalerta\nadmin\nowner\nurgente\ncanal\nsala",
          pt: "enviar\nmensagem\navisar\nnotificar\nalerta\nadmin\nowner\nurgente\ncanal\nsala",
          vi: "gửi\ntin nhắn\nthông báo\nkhẩn cấp\nkênh\nphòng",
          tl: "padala\nmensahe\nabiso\nalerto\nadmin\nowner\nurgent\nchannel\nroom",
        },
      },
    },
    send_admin_message: {
      strong: {
        base: "message admin\nnotify owner\nalert admin\ntell admin\ntell owner\nescalate",
        locales: {
          "zh-CN": "通知管理员\n告诉管理员\n通知 owner\n升级处理",
          ko: "관리자에게 알려\n관리자한테 말해\nowner에게 알려\n에스컬레이션",
          es: "avisar al admin\navisar al owner\ndecirle al admin\nescalar",
          pt: "avisar o admin\navisar o owner\nfalar com o admin\nescalar",
          vi: "báo admin\nbao admin\nbáo owner\nleo thang",
          tl: "sabihan ang admin\nabisuhan ang owner\ni-escalate",
        },
      },
      weak: {
        base: "admin\nowner\nnotify\nalert\nurgent\nescalate\nimportant",
        locales: {
          "zh-CN": "管理员\nowner\n通知\n提醒\n紧急\n升级\n重要",
          ko: "관리자\nowner\n알림\n긴급\n중요\n에스컬레이션",
          es: "admin\nowner\navisar\nalerta\nurgente\nescalar\nimportante",
          pt: "admin\nowner\navisar\nalerta\nurgente\nescalar\nimportante",
          vi: "admin\nowner\nbáo\nkhẩn cấp\nquan trọng",
          tl: "admin\nowner\nabiso\nurgent\nimportante\nescalate",
        },
      },
    },
    search_conversations: {
      strong: {
        base: "search conversations\nsearch chats\nsearch messages\nfind messages\nfind conversation",
        locales: {
          "zh-CN": "搜索对话\n搜索聊天\n搜索消息\n查找消息",
          ko: "대화 검색\n채팅 검색\n메시지 검색\n메시지 찾기",
          es: "buscar conversaciones\nbuscar chats\nbuscar mensajes\nencontrar mensajes",
          pt: "buscar conversas\nbuscar chats\nbuscar mensagens\nencontrar mensagens",
          vi: "tìm cuộc trò chuyện\ntìm tin nhắn\ntra cứu cuộc trò chuyện",
          tl: "hanapin ang usapan\nhanapin ang chat\nhanapin ang mensahe",
        },
      },
      weak: {
        base: "search\nfind\nrecall\nremember\nsaid\nmentioned\ntalked about\ndiscussed\nearlier\npreviously\nconversation",
        locales: {
          "zh-CN": "搜索\n查找\n记得\n提到\n聊过\n之前\n对话",
          ko: "검색\n찾기\n기억\n말했\n언급\n이전\n대화",
          es: "buscar\nencontrar\nrecordar\ndijiste\nmencionaste\nantes\nconversación\nconversacion",
          pt: "buscar\nencontrar\nlembrar\nfalou\nmencionou\nantes\nconversa",
          vi: "tìm\nnhớ\nnói\nnhắc\ntrước đó\ncuộc trò chuyện",
          tl: "hanap\ntandaan\nsinabi\nnabanggit\ndati\nusapan",
        },
      },
    },
    read_channel: {
      strong: {
        base: "read channel\nread chat\nread messages\nchannel history\nchat history\nchat log\nmessage history\nscroll back\nread room",
        locales: {
          "zh-CN": "读取频道\n查看聊天\n查看消息记录\n频道历史\n聊天记录",
          ko: "채널 읽기\n채팅 읽기\n메시지 기록\n채널 기록\n채팅 기록",
          es: "leer canal\nleer chat\nhistorial del canal\nhistorial del chat\nregistro del chat",
          pt: "ler canal\nler chat\nhistórico do canal\nhistórico do chat\nregistro do chat",
          vi: "đọc kênh\nđọc chat\nlịch sử kênh\nlịch sử chat",
          tl: "basahin ang channel\nbasahin ang chat\nhistory ng channel\nhistory ng chat",
        },
      },
      weak: {
        base: "channel\nchat\nhistory\nmessages\nconversation\nread\nroom\nlog\nrecent\nearlier",
        locales: {
          "zh-CN": "频道\n聊天\n历史\n消息\n对话\n查看\n房间\n最近\n之前",
          ko: "채널\n채팅\n기록\n메시지\n대화\n읽기\n방\n최근\n이전",
          es: "canal\nchat\nhistorial\nmensajes\nconversación\nconversacion\nleer\nsala\nreciente\nantes",
          pt: "canal\nchat\nhistórico\nhistorico\nmensagens\nconversa\nler\nsala\nrecente\nantes",
          vi: "kênh\nchat\nlịch sử\ntin nhắn\ncuộc trò chuyện\nđọc\nphòng\ngần đây\ntrước đó",
          tl: "channel\nchat\nhistory\nmensahe\nusapan\nbasahin\nroom\nrecent\nearlier",
        },
      },
    },
    read_messages: {
      strong: {
        base: "read messages with\nconversation with\nmessages with\nchat with\ndm history with\nmessage history with\nshow messages with\ncheck messages with",
        locales: {
          "zh-CN": "查看与某人的消息\n与某人的对话\n查看私信记录",
          ko: "누군가와의 메시지 보기\n누군가와의 대화\ndm 기록 보기",
          es: "leer mensajes con\nconversación con\nconversacion con\nmensajes con\nchat con",
          pt: "ler mensagens com\nconversa com\nmensagens com\nchat com",
          vi: "đọc tin nhắn với\ncuộc trò chuyện với\ntin nhắn với",
          tl: "basahin ang mga mensahe kasama si\nusapan kasama si\nmga mensahe kasama si",
        },
      },
      weak: {
        base: "messages with\nconversation\ndm\ndirect message\nperson\ncontact\nchat with\nhistory with",
        locales: {
          "zh-CN": "消息\n对话\n私信\n联系人",
          ko: "메시지\n대화\ndm\n연락처",
          es: "mensajes\nconversación\nconversacion\ndm\ncontacto",
          pt: "mensagens\nconversa\ndm\ncontato",
          vi: "tin nhắn\ncuộc trò chuyện\ndm\nliên hệ",
          tl: "mensahe\nusapan\ndm\ncontact",
        },
      },
    },
    stream_control: {
      strong: {
        base: "go live\ngo offline\nstart stream\nstop stream\nstart streaming\nstop streaming\nbegin stream\nend stream",
        locales: {
          "zh-CN": "开播\n下播\n开始直播\n停止直播",
          ko: "방송 시작\n방송 종료\n라이브 시작\n라이브 종료",
          es: "salir en vivo\nterminar stream\niniciar stream\ndetener stream",
          pt: "entrar ao vivo\nencerrar stream\niniciar stream\nparar stream",
          vi: "lên sóng\nket thuc stream\nkết thúc stream\nbắt đầu stream\nbat dau stream",
          tl: "mag live\ntapusin ang stream\nsimulan ang stream\nihinto ang stream",
        },
      },
      weak: {
        base: "live\nstream\nstreaming\nbroadcast\ntwitch\nyoutube\noffline\nonline",
        locales: {
          "zh-CN": "直播\n开播\n下播\n在线\n离线\ntwitch\nyoutube",
          ko: "라이브\n스트림\n스트리밍\n방송\n트위치\n유튜브\n오프라인\n온라인",
          es: "vivo\nstream\nstreaming\ntransmisión\ntransmision\ntwitch\nyoutube\noffline\nonline",
          pt: "ao vivo\nstream\nstreaming\ntransmissão\ntransmissao\ntwitch\nyoutube\noffline\nonline",
          vi: "stream\nphát sóng\nphat song\ntrực tiếp\ntwitch\nyoutube\noffline\nonline",
          tl: "live\nstream\nstreaming\nbroadcast\ntwitch\nyoutube\noffline\nonline",
        },
      },
    },
    search_entity: {
      strong: {
        base: "search entity\nfind person\nlookup user\nsearch contacts\nsearch rolodex\nwho is\ncontact details\nview person\nget contact",
        locales: {
          "zh-CN": "查找联系人\n查人\n搜索联系人\n谁是\n查看资料",
          ko: "사람 찾기\n연락처 검색\n사용자 조회\n누구야\n프로필 보기",
          es: "buscar persona\nencontrar persona\nbuscar contactos\nquien es\nquién es\nver perfil",
          pt: "buscar pessoa\nencontrar pessoa\nbuscar contatos\nquem é\nquem e\nver perfil",
          vi: "tìm người\ntìm liên hệ\ntra người dùng\nai là\nxem hồ sơ",
          tl: "hanapin ang tao\nhanapin ang contact\nsino si\ntingnan ang profile",
        },
      },
      weak: {
        base: "person\ncontact\nentity\nuser\nlookup\nwho\nprofile\nidentity\nrolodex\ndetails",
        locales: {
          "zh-CN": "联系人\n用户\n谁\n档案\n身份\n详情",
          ko: "사람\n연락처\n사용자\n누구\n프로필\n신원\n정보",
          es: "persona\ncontacto\nusuario\nquien\nquién\nperfil\nidentidad\ndetalles",
          pt: "pessoa\ncontato\nusuário\nusuario\nquem\nperfil\nidentidade\ndetalhes",
          vi: "người\nliên hệ\nngười dùng\nai\nhồ sơ\ndanh tính\nchi tiết",
          tl: "tao\ncontact\nuser\nsino\nprofile\nidentity\ndetails",
        },
      },
    },
    link_entity: {
      strong: {
        base: "merge contact\nmerge contacts\nlink contact\nlink contacts\nlink identities\nsame person\nsame human\ncombine contacts\nthese are the same\nduplicate contact\ndedupe contact",
        locales: {
          "zh-CN": "合并联系人\n关联联系人\n同一个人\n重复联系人",
          ko: "연락처 병합\n연락처 연결\n같은 사람\n중복 연락처",
          es: "fusionar contacto\nvincular contacto\nmisma persona\ncontacto duplicado\ncombinar contactos",
          pt: "mesclar contato\nvincular contato\nmesma pessoa\ncontato duplicado\ncombinar contatos",
          vi: "gộp liên hệ\nliên kết liên hệ\ncùng một người\nliên hệ trùng lặp",
          tl: "pagsamahin contact\ni-link ang contact\nparehong tao\nduplicate contact",
        },
      },
    },
    lifeops: {
      strong: {
        base: "todo\nto-do\nto do\ntask\nhabit\nroutine\nreminder\nalarm\ngoal\ntrack\nstreak\nlifeops\nlife ops\nworkout\nexercise\nmeditation\nchecklist\nself-care\nwellness\naccountability",
        locales: {
          "zh-CN":
            "待办\n代办事项\n待办事项\n任务\n习惯\n日程\n提醒\n闹钟\n目标\n打卡\n签到\n追踪\n锻炼\n健身\n冥想\n自律\n早起",
          ko: "할일\n할 일\n과제\n습관\n루틴\n알림\n알람\n목표\n추적\n스트릭\n운동\n명상\n투두\n체크리스트\n스케줄\n리마인더\n자기관리",
          es: "tarea\ntareas\nhabito\nhábito\nrutina\nrecordatorio\nalarma\nmeta\nmetas\nobjetivo\nseguimiento\nrastrear\npendiente\npendientes\nejercicio\nentrenamiento\nmeditación\nmeditacion\nracha\nlista de tareas\nquehacer\nquehaceres",
          pt: "tarefa\ntarefas\nhabito\nhábito\nrotina\nlembrete\nalarme\nmeta\nmetas\nobjetivo\nacompanhamento\nrastrear\nexercício\nexercicio\ntreino\nmeditação\nmeditacao\nsequência\nsequencia\nlista de tarefas\nafazer\nafazeres\npendência\npendencia",
          vi: "việc cần làm\nviec can lam\nnhiệm vụ\nnhiem vu\nthói quen\nthoi quen\nnhắc nhở\nnhac nho\nchuông báo\nchuong bao\nmục tiêu\nmuc tieu\ntheo dõi\ntheo doi\ntập thể dục\ntap the duc\nthiền\nthien",
          tl: "gawain\ngawi\nrutina\npaalala\nalarma\nlayunin\nsubaybay\nehersisyo\nmeditasyon\nlistahan\ntsek\nworkout\ngoal\nreminder\ntask",
        },
      },
      weak: {
        base: "done\nfinished\ncompleted\nskip\nsnooze\nlater\npostpone\ndefer\nmark\ncheck off\ndelete\nremove\ncancel\nupdate\nchange\nedit\nmodify\noverview\nsummary\nstatus\nprogress\nactive\nwhat do i have\nwhat's left",
        locales: {
          "zh-CN":
            "完成\n做完了\n跳过\n推迟\n稍后\n延迟\n标记\n删除\n移除\n取消\n更新\n修改\n编辑\n概览\n摘要\n状态\n进度\n活跃",
          ko: "완료\n끝났어\n건너뛰기\n나중에\n미루기\n연기\n표시\n삭제\n제거\n취소\n수정\n변경\n편집\n개요\n요약\n상태\n진행\n활성",
          es: "hecho\nterminado\ncompletado\nomitir\nsaltar\nposponer\naplazar\ndespues\ndespués\nmarcar\neliminar\nquitar\ncancelar\nactualizar\ncambiar\neditar\nmodificar\nresumen\nestado\nprogreso\nactivo",
          pt: "feito\nterminado\nconcluido\nconcluído\npular\nadiar\ndepois\nmarcar\nexcluir\nremover\ncancelar\natualizar\nalterar\neditar\nmodificar\nresumo\nestado\nprogresso\nativo",
          vi: "xong\nhoàn thành\nbỏ qua\nđể sau\nhoãn\nđánh dấu\nxóa\nhủy\ncập nhật\nthay đổi\nsửa\ntổng quan\ntóm tắt\ntrạng thái\ntiến độ",
          tl: "tapos\nnatapos\nlaktawan\nmamaya\nipagpaliban\nmarkahan\ntanggalin\nalisin\nkanselahin\nbaguhin\ni-edit\nbuod\nestado\nprogreso\naktibo",
        },
      },
    },
    lifeops_complete: {
      strong: {
        base: "done\nfinished\ncompleted\ndid it\ndid that\ndid my\ndid the\nmark done\nmark complete\nmark as done\nchecked off\nticked off\ncrossed off\njust finished\njust completed\njust did\ni already\ni've done\ni have done\nall done\ngot it done\ntook care of it\nknocked it out\ncrushed it\nnailed it\nhandled it\naccomplished\nyep done",
        locales: {
          "zh-CN":
            "完成了\n做完了\n已完成\n搞定了\n搞定\n弄好了\n做好了\n打卡\n已做\nOK了\n完事了\n好了\n办完了\n整完了",
          ko: "했어\n했어요\n완료\n끝났어\n끝냈어\n다했어\n다 했어\n마쳤어\n체크\n끝\n했습니다\n완료했어\n완료했습니다\n해냈어\n클리어\n했지",
          es: "hecho\nlisto\nterminé\ntermine\nterminado\ncompleté\ncomplete\ncompletado\nya lo hice\nya hice\nmarcar hecho\nmarcar completo\nya\nya está\nya esta\nlo hice\nlo terminé\nlo termine\nacabé\nacabe\ncumplido\ndale",
          pt: "feito\npronto\nterminei\nterminado\ncompletei\nconcluí\nconclui\nconcluído\nconcluido\njá fiz\nja fiz\nmarcar feito\nmarcar concluído\ntá feito\nta feito\nfiz\nacabei\nbeleza\ntá pronto\nta pronto\nresolvido\nfinalizado",
          vi: "xong rồi\nxong roi\nđã xong\nda xong\nhoàn thành rồi\nhoan thanh roi\nđã làm\nda lam\nđánh dấu xong\ndanh dau xong\nxong\nlàm rồi\nlam roi\nok rồi\nok roi\nxử lý xong\nxu ly xong",
          tl: "tapos na\nnatapos na\nginawa ko na\nnatapos ko\nmarkahang tapos\nayos na\nokay na\ndone na\ntapos ko na\ngoods na",
        },
      },
    },
    lifeops_skip: {
      strong: {
        base: "skip\npass on\nnot today\nskip today\nskip this\nnah\npass\nnope\nnot doing it\nnot gonna\ngonna skip\ncan't today\nnot this time\nhard pass\nno thanks",
        locales: {
          "zh-CN":
            "跳过\n今天不做\n今天跳过\n算了\n不了\n不想做\n懒得做\n免了\n不做了\n放弃",
          ko: "건너뛰기\n오늘 안 해\n오늘은 패스\n패스\n스킵\n안 할래\n됐어\n안 해\n귀찮아\n넘어가",
          es: "omitir\nsaltar\nhoy no\npaso\npasar\nnah\nno quiero\ndejalo\ndéjalo\npaso de eso\nnel\nque va",
          pt: "pular\nhoje não\nhoje nao\npassar\ndeixa pra lá\ndeixa pra la\nnão quero\nnao quero\nnah\nnem\nto fora\npróximo\nproximo",
          vi: "bỏ qua\nbo qua\nhôm nay không\nhom nay khong\nthôi\nthoi\nkhỏi\nkhoi\nkhông làm\nkhong lam\nbỏ đi\nbo di",
          tl: "laktawan\nhindi ngayon\npasa\nskip\nayaw ko\nwag na\ndi ko gagawin",
        },
      },
    },
    lifeops_snooze: {
      strong: {
        base: "snooze\nremind me later\nremind me again\npostpone\ndefer\npush back\npush it back\npush that back\nput off\nput it off\nput that off\nin a bit\nhold off\nnot right now\nmaybe later\nnot yet\ncome back later\nask me again\ngive me a minute",
        locales: {
          "zh-CN":
            "推迟\n稍后\n晚点再说\n等下提醒\n延后\n延迟\n一会儿再说\n先不急\n别急\n缓缓\n等等\n明天再说\n过一会儿",
          ko: "나중에\n미루기\n다시 알려줘\n나중에 알려줘\n연기\n미루다\n잠깐\n조금 뒤에\n이따가\n좀 있다가\n잠시만",
          es: "posponer\naplazar\nmás tarde\nmas tarde\ndespués\ndespues\nrecuérdame después\nrecuerdame despues\nahora no\nahorita no\nahorita\nen un rato\nluego\nal rato\nun momento",
          pt: "adiar\nmais tarde\ndepois\nlembrar depois\npostergar\nagora não\nagora nao\ndaqui a pouco\njá já\nja ja\nperaí\nperai\ncalma\nespera",
          vi: "để sau\nde sau\nhoãn\nhoan\nnhắc lại sau\nnhac lai sau\nchờ chút\ncho chut\nchưa\nchua\ntừ từ\ntu tu\nlát nữa\nlat nua\ntí nữa\nti nua",
          tl: "mamaya\nipagpaliban\nipaalala mamaya\nmamaya na lang\nsandali lang\nsaglit\ndi muna\nhindi pa\nmaya-maya\nlater",
        },
      },
    },
    lifeops_delete: {
      strong: {
        base: "delete\nremove\ncancel\nget rid of\ndrop\nstop tracking\nstop the\nstop my\nditch\nscrap\nnuke it\nkill it\ntrash\ntoss\nforget about\nforget it\nnever mind\nno longer need\ndon't need this\ndon't want this",
        locales: {
          "zh-CN":
            "删除\n移除\n取消\n不要了\n停止追踪\n停止跟踪\n去掉\n扔掉\n不做了\n不需要了\n干掉",
          ko: "삭제\n제거\n취소\n없애줘\n추적 중지\n그만 추적\n지워줘\n버려\n필요 없어\n그만\n빼줘\n캔슬",
          es: "eliminar\nquitar\nborrar\ncancelar\ndejar de rastrear\ndejar de seguir\nborra\nolvídate\nolvidate\nno necesito\nya no quiero\nsácalo\nsacalo\ntíralo\ntiralo",
          pt: "excluir\ndeletar\nremover\ncancelar\nparar de rastrear\nparar de acompanhar\napagar\napaga\njoga fora\ntira\nnão preciso\nnao preciso\nnão quero mais\nnao quero mais\nesquece",
          vi: "xóa\nxoa\nhủy\nhuy\nbỏ\nbo\nngừng theo dõi\nngung theo doi\ngỡ\ngo\nbỏ đi\nbo di\nkhông cần nữa\nkhong can nua\nquên đi\nquen di",
          tl: "tanggalin\nalisin\nkanselahin\nitigil ang pagsubaybay\ndelete\nitapon\ndi ko na kailangan\nkalimutan na\nwag na",
        },
      },
    },
    lifeops_update: {
      strong: {
        base: "update\nchange\nedit\nmodify\nadjust\nrename\nreschedule\ntweak\nfix\nswitch\nmove\nset to\nswap\nrevise",
        locales: {
          "zh-CN":
            "更新\n修改\n编辑\n调整\n重命名\n改时间\n重新安排\n改\n换\n改成\n换成\n微调",
          ko: "수정\n변경\n편집\n조정\n이름 바꾸기\n일정 변경\n바꿔줘\n고쳐줘\n바꿔\n고쳐\n옮기기\n업데이트",
          es: "actualizar\ncambiar\neditar\nmodificar\najustar\nrenombrar\nreprogramar\narreglar\narregla\nmover\ncámbialo\ncambialo\ncorregir\nponle",
          pt: "atualizar\nalterar\neditar\nmodificar\najustar\nrenomear\nreagendar\narrumar\narruma\nmudar\nmuda\ntrocar\ntroca\nmexer\ncorrigir",
          vi: "cập nhật\ncap nhat\nthay đổi\nthay doi\nsửa\nsua\nđiều chỉnh\ndieu chinh\nđổi tên\ndoi ten\nđổi lịch\ndoi lich\nchỉnh\nchinh\nđổi\ndoi\ndời",
          tl: "baguhin\ni-edit\ni-adjust\npalitan ang pangalan\npalitan ang iskedyul\nupdate\nchange\nayusin\nilipat",
        },
      },
    },
    lifeops_reminder_pref: {
      strong: {
        base: "stop reminding me\ndon't remind me\npause reminders\nresume reminders\nmore reminders\nless reminders\nfewer reminders\nnormal reminders\nmute reminders\nhigh priority only\nonly high priority\nbe more persistent\nmore persistent\nremind me less\nremind me more\nremind less\nremind more\nstart reminding me again\nturn reminders back on\nstop nagging\nquit bugging me\nenough reminders\ntoo many reminders\nchill with the reminders\nbug me more\nnag me about\nkeep on me about\nstay on top of me",
        locales: {
          "zh-CN":
            "停止提醒\n别提醒了\n暂停提醒\n恢复提醒\n多提醒\n少提醒\n静音提醒\n仅高优先\n别烦我\n别催了\n多催催\n盯着我",
          ko: "알림 중지\n알림 그만\n알림 일시 중지\n알림 재개\n알림 더\n알림 줄여\n알림 음소거\n높은 우선순위만\n좀 그만\n자꾸 알려줘\n계속 알려줘\n잔소리 그만",
          es: "dejar de recordarme\nno me recuerdes\npausar recordatorios\nreanudar recordatorios\nmás recordatorios\nmas recordatorios\nmenos recordatorios\nrecordatorios normales\nsilenciar recordatorios\nsolo prioridad alta\ndeja de molestar\nno me molestes\nya basta de recordatorios\ninsísteme\ninsisteme",
          pt: "parar de lembrar\nnão me lembre\nnao me lembre\npausar lembretes\nretomar lembretes\nmais lembretes\nmenos lembretes\nlembretes normais\nsilenciar lembretes\napenas alta prioridade\npara de encher\nchega de lembrete\nme cobra mais\ninsiste mais",
          vi: "ngừng nhắc\nngung nhac\nđừng nhắc\ndung nhac\ntạm dừng nhắc\ntam dung nhac\ntiếp tục nhắc\ntiep tuc nhac\nnhắc nhiều hơn\nnhac nhieu hon\nnhắc ít hơn\nnhac it hon\ntắt nhắc\ntat nhac\nđủ rồi\ndu roi",
          tl: "itigil ang paalala\nhuwag na akong paalalahanan\ni-pause ang paalala\nituloy ang paalala\ndagdagan ang paalala\nbawasan ang paalala\ntama na\nstop na\ntigilan mo na",
        },
      },
    },
    lifeops_overview: {
      strong: {
        base: "overview\nsummary\nwhat's active\nwhat is active\nstatus\nwhat do i have\nshow me everything\nwhat's left\nwhat is left\nstill left\nwhat do i still need\nanything else to do\nneed to get done\nneed to finish\nget done today\nanything else\nstill need to do\nwhat's on my plate\nwhat am i juggling\nwhere do things stand\ngive me the rundown\ncatch me up\nwhat's pending\nwhat's outstanding\nshow my tasks\nmy list\nmy tasks\nhow many tasks\nlist everything",
        locales: {
          "zh-CN":
            "概览\n总结\n摘要\n状态\n还有什么\n剩余任务\n活跃任务\n我还要做什么\n都有啥\n看一下\n我的任务\n还剩什么\n有什么要做的",
          ko: "개요\n요약\n상태\n뭐 남았어\n남은 거\n활성 항목\n아직 할 거\n뭐 해야 돼\n뭐 해야 해\n할 일 목록\n얼마나 남았어\n보여줘",
          es: "resumen\nestado\nque me queda\nqué me queda\nque tengo\nqué tengo\nmostrar todo\ntareas activas\nqué hay pendiente\nque hay pendiente\nmis tareas\nmi lista\nqué falta\nque falta\nen qué ando\nen que ando",
          pt: "resumo\nestado\no que falta\no que tenho\nmostrar tudo\ntarefas ativas\no que tem pendente\nminhas tarefas\nminha lista\nquanto falta\ncadê minhas coisas\ncade minhas coisas",
          vi: "tổng quan\ntong quan\ntóm tắt\ntom tat\ntrạng thái\ntrang thai\ncòn gì\ncon gi\ncòn gì nữa\ncon gi nua\nviệc đang làm\nviec dang lam\ndanh sách\ndanh sach\ncho xem\ncó gì\nco gi",
          tl: "buod\nestado\nano pa ang natitira\nipakita lahat\nmga aktibong gawain\nano ang mga gawain ko\nlista ko\nanong meron\nshow",
        },
      },
    },
    lifeops_cadence: {
      strong: {
        base: "every day\neveryday\ndaily\nweekly\nmonthly\nweekdays\nweekends\neach day\neach morning\neach night\neach week\neach month\nevery week\nevery month\nevery morning\nevery afternoon\nevery evening\nevery night\ntwice a day\nper day\nper week\nthroughout the day\nwith lunch\nwith breakfast\nwith dinner\ntimes a day\ntimes per day\ntimes a week\nonce a day\nonce a week\nbefore bed\nafter work\nwhen i wake up\nfirst thing in the morning\nat night\nin the morning\non mondays\non tuesdays\non wednesdays\non thursdays\non fridays\non saturdays\non sundays",
        locales: {
          "zh-CN":
            "每天\n每日\n每周\n每月\n工作日\n周末\n每个早上\n每个下午\n每个晚上\n一天两次\n每天一次\n起床后\n睡前\n下班后\n上班前\n隔天\n每隔一天\n一周三次",
          ko: "매일\n매주\n매월\n평일\n주말\n매일 아침\n매일 저녁\n하루에 두 번\n하루에 한 번\n일어나면\n자기 전에\n퇴근 후\n출근 전\n격일\n주 3회\n월수금\n일주일에 한 번",
          es: "cada día\ncada dia\ndiario\ndiariamente\nsemanal\nsemanalmente\nmensual\nmensualmente\nentre semana\nfin de semana\nfines de semana\ncada mañana\ncada tarde\ncada noche\ndos veces al día\ndos veces al dia\npor día\npor dia\nantes de dormir\nal despertar\ndespués del trabajo\ndespues del trabajo\nlunes a viernes\ntodos los días\ntodos los dias\ncada rato",
          pt: "todo dia\ntodos os dias\ndiário\ndiario\ndiariamente\nsemanal\nsemanalmente\nmensal\nmensalmente\ndia de semana\nfim de semana\ntoda manhã\ntoda manha\ntoda tarde\ntoda noite\nduas vezes ao dia\npor dia\nantes de dormir\nao acordar\ndepois do trabalho\nsegunda a sexta\ndia sim dia não\ndia sim dia nao",
          vi: "mỗi ngày\nmoi ngay\nhàng ngày\nhang ngay\nhàng tuần\nhang tuan\nhàng tháng\nhang thang\nngày trong tuần\ncuối tuần\ncuoi tuan\nmỗi sáng\nmoi sang\nmỗi chiều\nmoi chieu\nmỗi tối\nmoi toi\nhai lần mỗi ngày\ntrước khi ngủ\ntruoc khi ngu\nkhi thức dậy\nkhi thuc day\nsau giờ làm\nsau gio lam\ncách ngày\ncach ngay",
          tl: "araw-araw\nlingguhan\nbuwanan\nweekdays\nweekends\ntuwing umaga\ntuwing hapon\ntuwing gabi\ndalawang beses sa isang araw\nbago matulog\npagkagising\npagkatapos ng trabaho\neveryday\ndaily",
        },
      },
    },
    lifeops_goal: {
      strong: {
        base: "goal\ngoals\naspiration\nlife goal\nachieve\naim\ntarget\nambition\nmilestone\nobjective\ndream\nbucket list\nresolution\ni want to\ni wanna\nworking toward\nworking towards\nstrive\nvision\npurpose\nintention",
        locales: {
          "zh-CN":
            "目标\n志向\n梦想\n愿望\n里程碑\n想要\n追求\n心愿\n计划\n努力\n愿景",
          ko: "목표\n꿈\n포부\n야망\n이정표\n하고 싶다\n되고 싶다\n비전\n계획\n다짐\n버킷리스트",
          es: "meta\nmetas\nobjetivo\nobjetivos\naspiración\naspiracion\nlograr\nsueño\nambición\nambicion\nquiero\npropósito\nproposito\nresolución\nresolucion\nplan",
          pt: "meta\nmetas\nobjetivo\nobjetivos\naspiração\naspiracao\nalcançar\nalcancar\nsonho\nambição\nambicao\nquero\npropósito\nproposito\nresolução\nresolucao\nplano",
          vi: "mục tiêu\nmuc tieu\nước mơ\nuoc mo\nhoài bão\nhoai bao\nkhát vọng\nkhat vong\nmuốn\nmuon\nquyết tâm\nquyet tam\nkế hoạch\nke hoach",
          tl: "layunin\npangarap\nambisyon\nmithiin\ngusto ko\nplano\nresolusyon\ngoal\nbucket list",
        },
      },
    },
    lifeops_escalation: {
      strong: {
        base: "escalate\nescalation\nreminder plan\nset up sms\nset up text\nset up voice\nnotify if\ntext me if\ncall me if\nsms if\ntext if i ignore\ntext if i miss\ncall if i ignore\ncall if i miss\ntext me if i ignore\ntext me if i miss\ncall me if i ignore\ncall me if i miss\nnag me\nbug me\nkeep bugging me\nblow up my phone\nping me\nif i don't respond\nif i don't do it",
        locales: {
          "zh-CN":
            "升级\n升级提醒\n设置短信\n设置语音\n如果忽略就发短信\n如果忽略就打电话\n催我\n盯紧\n如果我不做\n如果我不回复",
          ko: "에스컬레이션\n알림 계획\n문자 설정\n음성 설정\n무시하면 문자\n무시하면 전화\n계속 알려줘\n안 하면 문자해\n잔소리해줘",
          es: "escalar\nescalación\nescalacion\nplan de recordatorio\nconfigurar sms\nconfigurar texto\nconfigurar voz\nnotificar si\nenviar texto si ignoro\nllamar si ignoro\ninsísteme\ninsisteme\nsi no respondo\nsi no lo hago",
          pt: "escalar\nescalação\nescalacao\nplano de lembrete\nconfigurar sms\nconfigurar texto\nconfigurar voz\nnotificar se\nenviar mensagem se ignorar\nligar se ignorar\nme cobre\nse eu não fizer\nse eu nao fizer",
          vi: "leo thang\nkế hoạch nhắc nhở\nke hoach nhac nho\nthiết lập sms\nthiet lap sms\nnhắn tin nếu bỏ lỡ\nnhan tin neu bo lo\ngọi nếu bỏ lỡ\ngoi neu bo lo",
          tl: "i-escalate\nplano ng paalala\ni-setup ang sms\ni-text kung hindi pinansin\ntawagan kung hindi pinansin\npag hindi ko ginawa\nkulitin mo ako\ntext mo ako",
        },
      },
    },
    lifeops_phone: {
      strong: {
        base: "phone\ntext me\ncall me\nsms\nmy number\nvoice call\nmy phone number\nphone number\ntxt me\nring me\nmy cell\nmobile\nmy mobile\nwhatsapp me\nwhatsapp",
        locales: {
          "zh-CN":
            "电话\n给我发短信\n打给我\n短信\n我的号码\n我的电话号码\n手机\n手机号\n微信",
          ko: "전화\n문자 보내줘\n전화해줘\n내 번호\n내 전화번호\n핸드폰\n휴대폰\n폰\n카톡\n카카오톡",
          es: "teléfono\ntelefono\nenvíame un mensaje\nmandame un mensaje\nllámame\nllamame\nsms\nmi número\nmi numero\ncelular\ncel\nmi cel\nmóvil\nmovil\nwhatsapp",
          pt: "telefone\nme mande mensagem\nme ligue\nsms\nmeu número\nmeu numero\ncelular\ncel\nmeu cel\nwhatsapp\nzap\nme zapa",
          vi: "điện thoại\ndien thoai\nnhắn tin cho tôi\nnhan tin cho toi\ngọi cho tôi\ngoi cho toi\nsố của tôi\nso cua toi\nsố điện thoại\nso dien thoai\ndi động\ndi dong\nzalo",
          tl: "telepono\ni-text ako\ntawagan ako\nsms\nnumero ko\ncellphone\ncp\nnumber ko\nviber",
        },
      },
    },
    lifeops_review: {
      strong: {
        base: "review\nhow am i doing\nhow's it going\nhow'd i do\nprogress\ncheck on\ncheck goal\ncheck my goal\nprogress report\nam i on track\nam i keeping up\nwhere am i at\nrecap\nstreak check\ngoal check\nhabit check",
        locales: {
          "zh-CN":
            "回顾\n进展如何\n检查进度\n查看目标\n我做得怎么样\n看看进度\n怎么样了\n表现如何\n坚持得怎样",
          ko: "리뷰\n어떻게 하고 있어\n진행 상황\n목표 확인\n잘 하고 있어\n얼마나 했어\n성과\n습관 체크\n스트릭 확인",
          es: "revisar\ncómo voy\ncomo voy\nprogreso\nrevisar meta\nrevisar objetivo\ncómo me fue\ncomo me fue\nestoy en buen camino\nmi racha\ncómo llevo\ncomo llevo",
          pt: "revisar\ncomo estou indo\nprogresso\nverificar meta\nverificar objetivo\ncomo fui\nestou no caminho certo\nminha sequência\nminha sequencia\ncomo tá indo\ncomo ta indo",
          vi: "xem lại\nxem lai\ntiến triển thế nào\ntien trien the nao\ntiến độ\ntien do\nkiểm tra mục tiêu\nkiem tra muc tieu\nkết quả\nket qua\nđánh giá\ndanh gia",
          tl: "suriin\nkumusta ang progreso\ntingnan ang layunin\nkamusta\nreport",
        },
      },
    },
    affirmative: {
      strong: {
        base: "yes\nyeah\nyep\nyup\nok\nokay\nsure\nconfirm\nconfirmed\ngo ahead\ndo it\nplease do\nsounds good\ncorrect\nexactly\nperfect\nthat works\nlooks good\ngo for it\nlgtm\nabsolutely\naffirmative\napproved\nlets go\nlet's go\nsave it\ncreate it",
        locales: {
          "zh-CN":
            "是的\n好的\n确认\n可以\n没问题\n行\n对\n好\n确定\n同意\n当然\n就这样\n保存\n创建",
          ko: "네\n예\n좋아\n좋아요\n확인\n맞아\n괜찮아\n알겠어\n동의\n물론\n그래\n응\n저장\n만들어",
          es: "sí\nsi\nclaro\nvale\nbien\nconfirmar\nde acuerdo\nperfecto\nadelante\ncorrecto\nexacto\nhazlo\npor favor\nlisto\nguardar\ncrear",
          pt: "sim\nclaro\nok\nbeleza\nconfirmar\nde acordo\nperfeito\npode\ncorreto\nexato\nvai em frente\ncom certeza\nsalvar\ncriar",
          vi: "vâng\nrồi\nđược\nđồng ý\nđúng rồi\nok\nchắc chắn\nxác nhận\ntốt\nhay\nđúng\nlưu\ntạo",
          tl: "oo\nsige\ntama\nsigurado\nok\nayos na\nkumpirmahin\nsabi mo\nayan\ni-save\ngawin",
        },
      },
    },
    negative: {
      strong: {
        base: "no\nnope\nnah\ndon't\ndo not\nwait\nhold on\ncancel\nnevermind\nnever mind\nforget it\nskip it\nstop\nnot now\nnot yet",
        locales: {
          "zh-CN": "不\n不要\n不是\n取消\n等一下\n算了\n别\n停\n不用\n暂时不",
          ko: "아니요\n아니\n안돼\n취소\n잠깐\n됐어\n하지마\n멈춰\n아직\n나중에",
          es: "no\nnada\ncancelar\nespera\nolvídalo\nolvidalo\npara\ndetente\ntodavía no\naún no\naun no",
          pt: "não\nnao\nnada\ncancelar\nespera\nesqueça\nesqueca\npare\nainda não\nainda nao",
          vi: "không\nđừng\nhủy\nchờ\nthôi\ndừng\nchưa\nbỏ đi",
          tl: "hindi\nhuwag\nkanselahin\nteka\nkalimutan mo na\nhinto\nwag",
        },
      },
    },
    draft_edit: {
      strong: {
        base: "how about\nwhat about\ninstead\nactually\nmake it\nchange it\nedit it\nupdate it\nrename it\nswitch it\nswap it\nrather\nkeep it\nbut change\nbut make",
        locales: {
          "zh-CN":
            "改成\n换成\n改为\n换个\n怎么样\n还是\n改一下\n更新\n其实\n但是改",
          ko: "바꿔\n변경\n대신\n어떨까\n고쳐\n수정\n업데이트\n사실\n그런데",
          es: "cambiarlo\nmejor\nqué tal\nque tal\nen vez de\neditar\nactualizar\nrenombrar\nen realidad\npero cambia",
          pt: "mudar\nmelhor\nque tal\nem vez de\neditar\natualizar\nrenomear\nna verdade\nmas muda",
          vi: "đổi thành\nthay đổi\nsửa\ncập nhật\nthế nào\nthực ra\nnhưng đổi",
          tl: "palitan\nbaguhin\nimbes\ni-edit\ni-update\nsa halip\npero palitan",
        },
      },
    },
    temporal_next: {
      strong: {
        base: "next\nupcoming\nsoon\nabout to\ncoming up\nafter this",
        locales: {
          "zh-CN": "下一个\n即将\n马上\n接下来\n快到了",
          ko: "다음\n곧\n다가오는\n이제\n곧 있을",
          es: "próximo\nproximo\nsiguiente\npronto\na punto de",
          pt: "próximo\nproximo\nseguinte\nlogo\nem breve",
          vi: "tiếp theo\nsắp tới\nsớm\nsắp",
          tl: "susunod\nmalapit na\nmamaya",
        },
      },
    },
    temporal_followup: {
      strong: {
        base: "yesterday\ntoday\ntomorrow\ntonight\nlater\nearlier\nthis week\nnext week\nthe week after\nweek after next\nthis weekend\nnext weekend\nweekend\nthis month\nnext month\nthis year\nnext year\nlast year\nmonday\ntuesday\nwednesday\nthursday\nfriday\nsaturday\nsunday\nfind it\nlook it up\ncheck again\ntry to find\ntry again\nretry\nagain",
        locales: {
          "zh-CN":
            "昨天\n今天\n明天\n今晚\n稍后\n更早\n这周\n下周\n这个月\n下个月\n今年\n明年\n去年\n周一\n周二\n周三\n周四\n周五\n周六\n周日\n星期一\n星期二\n星期三\n星期四\n星期五\n星期六\n星期天\n再试\n查找\n再查\n再看看",
          ko: "어제\n오늘\n내일\n오늘밤\n나중에\n이번주\n다음주\n이번달\n다음달\n올해\n내년\n작년\n월요일\n화요일\n수요일\n목요일\n금요일\n토요일\n일요일\n다시\n찾아\n다시 시도\n다시 확인",
          es: "ayer\nhoy\nmañana\nesta noche\nluego\nmás tarde\nmas tarde\nesta semana\npróxima semana\nproxima semana\neste mes\npróximo mes\nproximo mes\neste año\neste ano\nlunes\nmartes\nmiércoles\nmiercoles\njueves\nviernes\nsábado\nsabado\ndomingo\nreintentar\nbuscar\notra vez\nde nuevo",
          pt: "ontem\nhoje\namanhã\namanha\nesta noite\nmais tarde\nesta semana\npróxima semana\nproxima semana\neste mês\neste mes\npróximo mês\nproximo mes\neste ano\nsegunda\nterça\nterca\nquarta\nquinta\nsexta\nsábado\nsabado\ndomingo\ntentar novamente\nprocurar\nde novo\noutra vez",
          vi: "hôm qua\nhôm nay\nngày mai\ntối nay\nsau\nsớm hơn\ntuần này\ntuần sau\ntháng này\ntháng sau\nnăm nay\nnăm sau\nnăm ngoái\nthứ hai\nthứ ba\nthứ tư\nthứ năm\nthứ sáu\nthứ bảy\nchủ nhật\nthử lại\ntìm\nlại",
          tl: "kahapon\nngayon\nbukas\nmamaya\nmamayang gabi\nngayong linggo\nsusunod na linggo\nngayong buwan\nsusunod na buwan\nngayong taon\nlunes\nmartes\nmiyerkules\nhuwebes\nbiyernes\nsabado\nlinggo\nsubukan muli\nhanapin\nulit\nmuli",
        },
      },
    },
  },
  provider: {
    recentConversations: {
      relevance: {
        base: "recent\nconversation\nsaid\ntold\ntalked\ndiscussed\nmentioned\nremember\nearlier\nbefore\nchat\nmessage",
        locales: {
          "zh-CN": "最近\n对话\n说过\n提到\n之前\n聊天\n消息",
          ko: "최근\n대화\n말했\n언급\n이전\n채팅\n메시지",
          es: "reciente\nconversación\nconversacion\ndijo\nmencionó\nmenciono\nantes\nchat\nmensaje",
          pt: "recente\nconversa\ndisse\nmencionou\nantes\nchat\nmensagem",
          vi: "gần đây\ngan day\ncuộc trò chuyện\nnói\nnhắc\ntrước đó\nchat\ntin nhắn",
          tl: "recent\nusapan\nsinabi\nnabanggit\ndati\nchat\nmensahe",
        },
      },
    },
    relevantConversations: {
      relevance: {
        base: "search\nfind\nremember\nwho said\nconversation about\ndiscussed\ntalked about\nmentioned",
        locales: {
          "zh-CN": "搜索\n查找\n记得\n谁说过\n提到\n聊过",
          ko: "검색\n찾기\n기억\n누가 말했어\n언급\n이야기했던",
          es: "buscar\nencontrar\nrecordar\nquién dijo\nquien dijo\nhablaron de\nmencionó\nmenciono",
          pt: "buscar\nencontrar\nlembrar\nquem disse\nfalaram sobre\nmencionou",
          vi: "tìm\nnhớ\nai đã nói\nai da noi\nnhắc đến\nđã bàn về\nda ban ve",
          tl: "hanap\ntandaan\nsino ang nagsabi\npinag-usapan\nnabanggit",
        },
      },
    },
    rolodex: {
      relevance: {
        base: "who\ncontact\nreach\nrolodex\nknow\nrelationship\nperson\npeople\nfriend\nuser",
        locales: {
          "zh-CN": "谁\n联系人\n联络\n关系\n人\n朋友\n用户",
          ko: "누구\n연락처\n연락\n관계\n사람\n친구\n사용자",
          es: "quién\nquien\ncontacto\ncontactar\nrelación\nrelacion\npersona\ngente\namigo\nusuario",
          pt: "quem\ncontato\ncontatar\nrelação\nrelacao\npessoa\npessoas\namigo\nusuário\nusuario",
          vi: "ai\nliên hệ\nlien he\nmối quan hệ\nmoi quan he\nngười\nbạn bè\nban be\nngười dùng\nnguoi dung",
          tl: "sino\ncontact\nkontak\nrelasyon\ntao\nmga tao\nkaibigan\nuser",
        },
      },
    },
    uiWidgets: {
      relevance: {
        base: "plugin\nplugins\ninstall\nsetup\nset up\nconfigure\nconfig\nenable\ndisable\nactivate\nconnect\nintegration\nhelp me\nhow do i\nhow to\nshow me\nform\nforms\nreminder\nreminders\nschedule\nscheduling\ndate\ntime\ndatetime\npicker\npick a date\npick a time\npolymarket\ndiscord\nopenai\nanthropic\ntelegram\ntwitch\nyoutube\ntwitter\napi key\ncredentials\nsecret",
        locales: {
          "zh-CN":
            "插件\n安装\n设置\n配置\n启用\n禁用\n激活\n连接\n集成\n帮我\n怎么\n给我看\n表单\napi key\n凭证\n密钥",
          ko: "플러그인\n설치\n설정\n구성\n활성화\n비활성화\n연결\n통합\n도와줘\n어떻게\n보여줘\n폼\napi key\n자격 증명\n비밀",
          es: "plugin\nplugins\ninstalar\nconfiguración\nconfiguracion\nconfigurar\nactivar\ndesactivar\nconectar\nintegración\nintegracion\nayúdame\nayudame\ncómo\ncomo\nmuéstrame\nmuestrame\nformulario\napi key\ncredenciales\nsecreto",
          pt: "plugin\nplugins\ninstalar\nconfiguração\nconfiguracao\nconfigurar\nativar\ndesativar\nconectar\nintegração\nintegracao\nme ajuda\ncomo faço\nmostrar\nformulário\nformulario\napi key\ncredenciais\nsegredo",
          vi: "plugin\ncài đặt\ncai dat\nthiết lập\nthiet lap\ncấu hình\ncau hinh\nbật\nbat\ntắt\ntat\nkết nối\nket noi\ntích hợp\ntich hop\ngiúp tôi\ngiup toi\nlàm sao\nlam sao\ncho tôi xem\nbiểu mẫu\nbieu mau\napi key\nthông tin xác thực\nthong tin xac thuc\nbí mật\nbi mat",
          tl: "plugin\nplugins\ni-install\ni-setup\ni-configure\nconfig\npaganahin\npatayin\ni-connect\nintegration\ntulungan mo ako\npaano\nipakita mo\nform\ninterface\napi key\ncredentials\nsecret",
        },
      },
    },
    uiGenerative: {
      relevance: {
        base: "dashboard\ntable\nchart\nmetrics\nui\ninterface\nvisualization\nvisualisation\nvisualize\nvisualise\ngraph\nplot\ndiagram\nanalytics\nkpi\nrender a\nbuild a dashboard",
        locales: {
          "zh-CN": "仪表盘\n表格\n图表\n指标\n界面",
          ko: "대시보드\n테이블\n차트\n지표\n인터페이스",
          es: "panel\ntabla\ngráfico\ngrafico\nmétricas\nmetricas\ninterfaz",
          pt: "painel\ntabela\ngráfico\ngrafico\nmétricas\nmetricas\ninterface",
          vi: "dashboard\nbảng\nbang\nbiểu đồ\nbieu do\nchỉ số\nchi so\ngiao diện\ngiao dien",
          tl: "dashboard\ntable\nchart\nmetrics",
        },
      },
    },
  },
  validate: {
    codingTaskRequest: {
      base: "build an app\nbuild a app\nbuild the app\nbuild me an app\nmake an app\ncreate an app\nwrite an app\nship an app\ndeploy an app\nbuild a website\nbuild a site\nbuild a page\nbuild a dashboard\nbuild a widget\nbuild a component\nbuild a script\nbuild a tool\nbuild an api\nbuild a bot\nbuild a cli\nbuild a plugin\nmake a website\nmake a site\nmake a dashboard\nmake a widget\nmake a component\nmake a script\nmake a tool\nmake an api\nmake a bot\nmake a cli\nmake a plugin\ncreate a website\ncreate a site\ncreate a page\ncreate a dashboard\ncreate a widget\ncreate a component\ncreate a script\ncreate a tool\ncreate an api\ncreate an endpoint\ncreate a bot\ncreate a cli\ncreate a plugin\ncreate a route\ncreate a handler\ncreate a module\ncreate a repo\nwrite a script\nwrite a component\nwrite an api\nwrite a function\nwrite a handler\nwrite a route\nwrite a module\ndeploy a server\ndeploy a site\ndeploy a website\ndeploy a bot\ndeploy a cli\ndeploy an api\nship a feature\nship a component\nspin up a server\nspin up an api\nspin up a bot\nadd an endpoint\nadd a route\nadd a handler\nadd an api\nadd a component\npull request\nmerge conflict\ngit push\ngit pull\ngit clone\ngit rebase\ntypescript error\ndebug the bug\ndebug this bug\ndebug a bug\ndebug the error\ndebug this error\ndebug the code\ndebug this code\nfix the bug\nfix a bug\nfix this bug",
      locales: {
        es: "construir una app\nconstruir una aplicación\nconstruir una aplicacion\ncrear una app\ncrear una aplicación\ncrear una aplicacion\nhacer una app\nhacer una aplicación\nhacer una aplicacion\nhazme una app\nconstruir un sitio\nconstruir un sitio web\nconstruir una página\nconstruir una pagina\nconstruir un panel\nconstruir un componente\nconstruir un script\nconstruir una herramienta\nconstruir una api\nconstruir un bot\nconstruir un cli\ncrear un sitio\ncrear un sitio web\ncrear una página\ncrear una pagina\ncrear un panel\ncrear un componente\ncrear un script\ncrear una herramienta\ncrear una api\ncrear un endpoint\ncrear un bot\ncrear un cli\ncrear un plugin\ncrear una ruta\nescribir un script\nescribir un componente\nescribir una api\nescribir una función\nescribir una funcion\ndesplegar un servidor\ndesplegar un sitio\ndesplegar un bot\ndesplegar una api\npull request\nconflicto de fusión\nconflicto de fusion\nerror de typescript\ndepurar el error\ndepurar este error\narreglar el bug\narreglar un bug\narreglar este bug\narreglar el error",
        pt: "construir um app\nconstruir um aplicativo\nconstruir uma aplicação\nconstruir uma aplicacao\ncriar um app\ncriar um aplicativo\ncriar uma aplicação\ncriar uma aplicacao\nfazer um app\nfazer um aplicativo\nconstruir um site\nconstruir uma página\nconstruir uma pagina\nconstruir um painel\nconstruir um componente\nconstruir um script\nconstruir uma ferramenta\nconstruir uma api\nconstruir um bot\nconstruir um cli\ncriar um site\ncriar uma página\ncriar uma pagina\ncriar um painel\ncriar um componente\ncriar um script\ncriar uma ferramenta\ncriar uma api\ncriar um endpoint\ncriar um bot\ncriar um cli\ncriar um plugin\ncriar uma rota\nescrever um script\nescrever um componente\nescrever uma api\nescrever uma função\nescrever uma funcao\nimplantar um servidor\nimplantar um site\nimplantar um bot\nimplantar uma api\npull request\nconflito de merge\nerro de typescript\ndepurar o erro\ndepurar este erro\ncorrigir o bug\ncorrigir um bug\ncorrigir este bug\nconsertar o bug",
        "zh-CN":
          "做一个应用\n做个应用\n做一个app\n做个app\n构建一个应用\n构建一个app\n创建一个应用\n创建一个app\n写一个应用\n写一个app\n做一个网站\n构建一个网站\n创建一个网站\n做一个页面\n创建一个页面\n做一个仪表板\n创建一个仪表板\n做一个组件\n创建一个组件\n写一个组件\n做一个脚本\n写一个脚本\n做一个工具\n创建一个工具\n做一个api\n创建一个api\n写一个api\n做一个机器人\n创建一个机器人\n做一个插件\n创建一个插件\n部署服务器\n部署网站\n部署机器人\n部署api\n拉取请求\n合并冲突\ntypescript错误\n调试错误\n修复bug\n修复这个bug\n修复错误",
        ko: "앱 만들어\n앱을 만들어\n앱 만들어줘\n앱을 만들어줘\n앱 빌드\n앱 빌드해\n앱 만들기\n웹사이트 만들어\n웹사이트 만들어줘\n사이트 만들어\n페이지 만들어\n대시보드 만들어\n컴포넌트 만들어\n스크립트 만들어\n스크립트 작성\n도구 만들어\napi 만들어\napi 작성\n엔드포인트 만들어\n봇 만들어\n봇 만들어줘\n플러그인 만들어\n라우트 만들어\n서버 배포\n사이트 배포\n봇 배포\napi 배포\n풀 리퀘스트\n머지 충돌\n타입스크립트 오류\n타입스크립트 에러\n버그 수정\n이 버그 수정\n에러 수정\n버그 디버그\n에러 디버그",
        vi: "xây dựng một ứng dụng\nxay dung mot ung dung\nxây dựng một app\nxay dung mot app\ntạo một ứng dụng\ntao mot ung dung\ntạo một app\ntao mot app\nlàm một ứng dụng\nlam mot ung dung\nlàm một app\nlam mot app\nviết một ứng dụng\nviet mot ung dung\nxây dựng một trang web\nxay dung mot trang web\ntạo một trang web\ntao mot trang web\ntạo một trang\ntao mot trang\ntạo một bảng điều khiển\ntao mot bang dieu khien\ntạo một thành phần\ntao mot thanh phan\nviết một script\nviet mot script\ntạo một script\ntao mot script\ntạo một công cụ\ntao mot cong cu\ntạo một api\ntao mot api\ntạo một endpoint\ntao mot endpoint\ntạo một bot\ntao mot bot\ntạo một plugin\ntao mot plugin\ntriển khai máy chủ\ntrien khai may chu\ntriển khai trang web\ntrien khai trang web\ntriển khai bot\ntrien khai bot\ntriển khai api\ntrien khai api\npull request\nxung đột merge\nxung dot merge\nlỗi typescript\nloi typescript\nsửa lỗi\nsua loi\nsửa bug\nsua bug\ngỡ lỗi\ngo loi",
        tl: "gumawa ng app\ngumawa ng aplikasyon\ngawan mo ako ng app\nlumikha ng app\nlumikha ng aplikasyon\ngumawa ng website\ngumawa ng site\ngumawa ng page\ngumawa ng dashboard\ngumawa ng component\ngumawa ng script\nmagsulat ng script\ngumawa ng tool\ngumawa ng api\ngumawa ng endpoint\ngumawa ng bot\ngumawa ng plugin\ni-deploy ang server\ni-deploy ang site\ni-deploy ang bot\ni-deploy ang api\npull request\nmerge conflict\ntypescript error\nayusin ang bug\nayusin ang error\ni-debug ang bug\ni-debug ang error",
      },
    },
    taskIntent: {
      base: "create task\nadd task\nnew task\nmake task\ncomplete task\nfinish task\ndone with task\nmark task done\ndelete task\nremove task\nupdate task\nedit task\nchange task\nlist tasks\nshow tasks\nmy tasks\nwhat are my tasks\nadd a todo\nadd a to-do\ncreate a to do\ntask list\ncheck off",
      locales: {
        es: "crear tarea\ncrea tarea\nagregar tarea\nagrega tarea\nañadir tarea\nanadir tarea\nnueva tarea\nhacer tarea\ncompletar tarea\nterminar tarea\nmarcar tarea hecha\neliminar tarea\nborrar tarea\nquitar tarea\nactualizar tarea\neditar tarea\ncambiar tarea\nlistar tareas\nmostrar tareas\nmis tareas\ncuáles son mis tareas\ncuales son mis tareas\nagregar un pendiente\nagrega un pendiente\nlista de tareas",
        pt: "criar tarefa\ncria tarefa\nadicionar tarefa\nadiciona tarefa\nnova tarefa\nfazer tarefa\ncompletar tarefa\nconcluir tarefa\nterminar tarefa\nmarcar tarefa feita\nexcluir tarefa\nremover tarefa\napagar tarefa\natualizar tarefa\neditar tarefa\nmudar tarefa\nlistar tarefas\nmostrar tarefas\nminhas tarefas\nquais são minhas tarefas\nquais sao minhas tarefas\nadicionar um afazer\nlista de tarefas",
        "zh-CN":
          "创建任务\n新建任务\n添加任务\n完成任务\n标记任务完成\n删除任务\n移除任务\n更新任务\n编辑任务\n修改任务\n列出任务\n显示任务\n我的任务\n我有什么任务\n添加待办\n新增待办\n任务列表\n勾选",
        ko: "작업 만들기\n작업 추가\n새 작업\n작업 완료\n작업 끝내\n완료 표시\n작업 삭제\n작업 제거\n작업 업데이트\n작업 수정\n작업 변경\n작업 목록\n작업 보여줘\n내 작업\n내 할 일이 뭐야\n할 일 추가\n투두 추가\n할 일 목록\n체크 표시",
        vi: "tạo tác vụ\ntao tac vu\ntạo nhiệm vụ\ntao nhiem vu\nthêm tác vụ\nthem tac vu\ntác vụ mới\ntac vu moi\nhoàn thành tác vụ\nhoan thanh tac vu\nkết thúc tác vụ\nket thuc tac vu\nđánh dấu hoàn thành\ndanh dau hoan thanh\nxóa tác vụ\nxoa tac vu\ngỡ tác vụ\ngo tac vu\ncập nhật tác vụ\ncap nhat tac vu\nsửa tác vụ\nsua tac vu\nthay đổi tác vụ\nthay doi tac vu\ndanh sách tác vụ\ndanh sach tac vu\nhiển thị tác vụ\nhien thi tac vu\ntác vụ của tôi\ntac vu cua toi\nthêm việc cần làm\nthem viec can lam\ndanh sách việc\ndanh sach viec",
        tl: "gumawa ng task\nmagdagdag ng task\nbagong task\ntapusin ang task\nkumpletuhin ang task\nmarkahan tapos\nburahin ang task\ntanggalin ang task\nalisin ang task\ni-update ang task\ni-edit ang task\nbaguhin ang task\nipakita ang tasks\nilista ang tasks\nmga task ko\nano ang mga task ko\nmagdagdag ng todo\nlistahan ng task\ni-check off",
      },
    },
  },
} as const satisfies ValidationKeywordTree;
