type ValidationKeywordLocale = "zh-CN" | "ko" | "es" | "pt" | "vi" | "tl";

type ValidationKeywordDoc = {
	base?: string;
	locales?: Partial<Record<ValidationKeywordLocale, string>>;
};

type ValidationKeywordTree = {
	[key: string]: ValidationKeywordTree | ValidationKeywordDoc;
};

function termDoc(value: string): string {
	return value.trim();
}

const VALIDATION_KEYWORD_DOCS = {
	action: {
		createTask: {
			request: {
				base: termDoc(`
					create task
					create trigger
					create a trigger
					set a trigger
					schedule a trigger
					schedule a task
					remind me
					reminder
					recurring
					repeat
					heartbeat
					cron
					run every
					run at
					every day
					every week
					every month
					every hour
				`),
				locales: {
					"zh-CN": termDoc(`
						创建任务
						创建触发器
						设置触发器
						安排任务
						提醒我
						提醒
						重复
						循环
						心跳
						定时
						每天
						每周
						每月
						每小时
					`),
					ko: termDoc(`
						작업 만들기
						트리거 만들기
						트리거 설정
						작업 예약
						알림
						리마인더
						반복
						하트비트
						크론
						매일
						매주
						매달
						매시간
					`),
					es: termDoc(`
						crear tarea
						crear disparador
						programa una tarea
						programa un disparador
						recordatorio
						recuérdame
						recurrente
						repetir
						cada día
						cada dia
						cada semana
						cada mes
						cada hora
					`),
					pt: termDoc(`
						criar tarefa
						criar gatilho
						programar tarefa
						programar gatilho
						lembrete
						lembra-me
						recorrente
						repetir
						cada dia
						cada semana
						cada mês
						cada mes
						cada hora
					`),
					vi: termDoc(`
						tạo tác vụ
						tao tac vu
						tạo trình kích hoạt
						tao trinh kich hoat
						lên lịch tác vụ
						len lich tac vu
						lời nhắc
						loi nhac
						nhắc tôi
						nhac toi
						lặp lại
						lap lai
						mỗi ngày
						moi ngay
						mỗi tuần
						moi tuan
					`),
					tl: termDoc(`
						gumawa ng task
						gumawa ng trigger
						iskedyul ang task
						iskedyul ang trigger
						paalala
						ipaalala
						paulit-ulit
						kada araw
						kada linggo
						kada buwan
						kada oras
					`),
				},
			},
		},
		searchContacts: {
			request: {
				base: termDoc(`
					list contacts
					show contacts
					search contacts
					find contacts
					who do i know
					friends
					colleagues
					vip
				`),
				locales: {
					"zh-CN": termDoc(`
						联系人列表
						显示联系人
						搜索联系人
						查找联系人
						我认识谁
						朋友
						同事
						贵宾
					`),
					ko: termDoc(`
						연락처 목록
						연락처 보여줘
						연락처 검색
						연락처 찾기
						내가 아는 사람
						친구
						동료
						VIP
					`),
					es: termDoc(`
						lista de contactos
						muestra contactos
						busca contactos
						encuentra contactos
						a quién conozco
						a quien conozco
						amigos
						colegas
						vip
					`),
					pt: termDoc(`
						lista de contatos
						mostrar contatos
						buscar contatos
						encontrar contatos
						quem eu conheço
						quem eu conheco
						amigos
						colegas
						vip
					`),
					vi: termDoc(`
						danh sách liên hệ
						danh sach lien he
						hiển thị liên hệ
						hien thi lien he
						tìm liên hệ
						tim lien he
						tôi quen ai
						toi quen ai
						bạn bè
						ban be
						đồng nghiệp
						dong nghiep
					`),
					tl: termDoc(`
						listahan ng contact
						ipakita ang contact
						hanapin ang contact
						sino ang kilala ko
						kaibigan
						kasamahan
						vip
					`),
				},
			},
		},
		addContact: {
			request: {
				base: termDoc(`
					add contact
					save contact
					remember contact
					categorize contact
					add to relationships
					save this person
				`),
				locales: {
					"zh-CN": termDoc(`
						添加联系人
						保存联系人
						记住联系人
						给联系人分类
						加入关系
						保存这个人
					`),
					ko: termDoc(`
						연락처 추가
						연락처 저장
						연락처 기억해
						연락처 분류
						관계에 추가
						이 사람 저장
					`),
					es: termDoc(`
						agrega contacto
						agregar contacto
						guarda contacto
						recuerda contacto
						categoriza contacto
						agrega a relaciones
						guarda a esta persona
					`),
					pt: termDoc(`
						adicionar contato
						adiciona contato
						salvar contato
						lembrar contato
						categorizar contato
						adicionar aos relacionamentos
						salvar esta pessoa
					`),
					vi: termDoc(`
						thêm liên hệ
						them lien he
						lưu liên hệ
						luu lien he
						ghi nhớ liên hệ
						ghi nho lien he
						phân loại liên hệ
						phan loai lien he
					`),
					tl: termDoc(`
						magdagdag ng contact
						i-save ang contact
						tandaan ang contact
						ikategorya ang contact
						i-save ang taong ito
					`),
				},
			},
		},
		updateContact: {
			request: {
				base: termDoc(`
					update contact
					edit contact
					modify contact
					change contact
					update relationship
					edit relationship
					change notes
					add tag
					remove tag
					add category
					remove category
				`),
				locales: {
					"zh-CN": termDoc(`
						更新联系人
						编辑联系人
						修改联系人
						更新关系
						编辑关系
						修改备注
						添加标签
						移除标签
						添加分类
						移除分类
					`),
					ko: termDoc(`
						연락처 업데이트
						연락처 수정
						연락처 변경
						관계 업데이트
						메모 변경
						태그 추가
						태그 제거
						분류 추가
						분류 제거
					`),
					es: termDoc(`
						actualiza contacto
						actualizar contacto
						edita contacto
						modifica contacto
						cambia contacto
						actualiza relación
						actualiza relacion
						cambia notas
						agrega etiqueta
						quita etiqueta
						agrega categoría
						agrega categoria
						quita categoría
						quita categoria
					`),
					pt: termDoc(`
						atualizar contato
						atualiza contato
						editar contato
						modificar contato
						mudar contato
						atualizar relacionamento
						mudar notas
						adicionar etiqueta
						remover etiqueta
						adicionar categoria
						remover categoria
					`),
					vi: termDoc(`
						cập nhật liên hệ
						cap nhat lien he
						sửa liên hệ
						sua lien he
						thay đổi liên hệ
						thay doi lien he
						cập nhật quan hệ
						cap nhat quan he
						thêm thẻ
						them the
						xóa thẻ
						xoa the
					`),
					tl: termDoc(`
						i-update ang contact
						i-edit ang contact
						baguhin ang contact
						i-update ang relasyon
						dagdagan ng tag
						alisin ang tag
						dagdagan ng kategorya
						alisin ang kategorya
					`),
				},
			},
		},
		removeContact: {
			request: {
				base: termDoc(`
					remove contact
					delete contact
					drop contact
					remove from relationships
					forget contact
				`),
				locales: {
					"zh-CN": termDoc(`
						移除联系人
						删除联系人
						从关系中移除
						忘记联系人
					`),
					ko: termDoc(`
						연락처 제거
						연락처 삭제
						관계에서 제거
						연락처 잊어
					`),
					es: termDoc(`
						elimina contacto
						eliminar contacto
						borra contacto
						quita de relaciones
						olvida contacto
					`),
					pt: termDoc(`
						remover contato
						excluir contato
						apagar contato
						remover dos relacionamentos
						esquecer contato
					`),
					vi: termDoc(`
						xóa liên hệ
						xoa lien he
						gỡ liên hệ
						go lien he
						xóa khỏi quan hệ
						xoa khoi quan he
					`),
					tl: termDoc(`
						alisin ang contact
						burahin ang contact
						tanggalin sa relationships
						kalimutan ang contact
					`),
				},
			},
		},
		scheduleFollowUp: {
			request: {
				base: termDoc(`
					follow up
					followup
					remind me
					check in
					check back
					reach out
					schedule follow-up
					schedule a reminder
				`),
				locales: {
					"zh-CN": termDoc(`
						跟进
						提醒我
						回访
						联系一下
						安排提醒
						安排跟进
					`),
					ko: termDoc(`
						후속 조치
						팔로업
						알려줘
						체크인
						다시 연락
						후속 일정 잡아
					`),
					es: termDoc(`
						seguimiento
						haz seguimiento
						recuérdame
						recuerdame
						vuelve a contactar
						revisa de nuevo
						programa seguimiento
					`),
					pt: termDoc(`
						acompanhamento
						faça acompanhamento
						faca acompanhamento
						lembra-me
						entre em contato de novo
						programe acompanhamento
					`),
					vi: termDoc(`
						theo dõi
						theo doi
						nhắc tôi
						nhac toi
						liên hệ lại
						lien he lai
						lên lịch theo dõi
						len lich theo doi
					`),
					tl: termDoc(`
						follow up
						paalalahanan mo ako
						check in
						makipag-ugnayan muli
						iskedyul ang follow up
					`),
				},
			},
		},
		followRoom: {
			request: {
				base: termDoc(`
					follow this room
					participate here
					engage here
					listen to this room
					join this room
					take interest
				`),
				locales: {
					"zh-CN": termDoc(`
						关注这个房间
						参与这里
						加入这个房间
						听这个房间
					`),
					ko: termDoc(`
						이 방을 팔로우해
						여기에 참여해
						이 방에 들어와
						이 방을 들어줘
					`),
					es: termDoc(`
						sigue esta sala
						participa aquí
						participa aqui
						únete a esta sala
						unete a esta sala
						presta atención aquí
						presta atencion aqui
					`),
					pt: termDoc(`
						siga esta sala
						participe aqui
						entre nesta sala
						preste atenção aqui
						preste atencao aqui
					`),
					vi: termDoc(`
						theo dõi phòng này
						theo doi phong nay
						tham gia ở đây
						tham gia o day
						vào phòng này
						vao phong nay
					`),
					tl: termDoc(`
						i-follow ang room na ito
						sumali dito
						makilahok dito
						makinig sa room na ito
					`),
				},
			},
		},
		muteRoom: {
			request: {
				base: termDoc(`
					mute
					silence
					quiet
					shut up
					stop talking
					be quiet
					hush
					shh
					no more
				`),
				locales: {
					"zh-CN": termDoc(`
						静音
						安静
						闭嘴
						别说话
						不要再说了
					`),
					ko: termDoc(`
						음소거
						조용히
						입 다물어
						말하지 마
						그만 말해
					`),
					es: termDoc(`
						silencia
						ponte en silencio
						cállate
						callate
						deja de hablar
						guarda silencio
					`),
					pt: termDoc(`
						silencia
						fique em silêncio
						fique em silencio
						cala a boca
						para de falar
						fique quieto
					`),
					vi: termDoc(`
						tắt tiếng
						tat tieng
						im lặng
						im lang
						đừng nói nữa
						dung noi nua
					`),
					tl: termDoc(`
						i-mute
						tumahimik
						tigilan ang pagsasalita
						wag ka nang magsalita
					`),
				},
			},
		},
		unmuteRoom: {
			request: {
				base: termDoc(`
					unmute
					unsilence
					listen again
					start talking
					talk again
					speak again
					enable
					resume
				`),
				locales: {
					"zh-CN": termDoc(`
						取消静音
						恢复说话
						再说话
						继续
						恢复
					`),
					ko: termDoc(`
						음소거 해제
						다시 말해
						다시 듣기
						재개
					`),
					es: termDoc(`
						activa el sonido
						quitar silencio
						vuelve a hablar
						reanuda
						escucha otra vez
					`),
					pt: termDoc(`
						tirar do silêncio
						tirar do silencio
						volte a falar
						retomar
						ouça de novo
						ouca de novo
					`),
					vi: termDoc(`
						bỏ tắt tiếng
						bo tat tieng
						nói lại đi
						noi lai di
						tiếp tục
						tiep tuc
					`),
					tl: termDoc(`
						i-unmute
						magsalita ulit
						ipagpatuloy
						makinig ulit
					`),
				},
			},
		},
		sendToAdmin: {
			request: {
				base: termDoc(`
					admin
					user
					tell admin
					notify admin
					inform admin
					update admin
					message admin
					send to admin
					communicate
					report
					alert
				`),
				locales: {
					"zh-CN": termDoc(`
						管理员
						用户
						告诉管理员
						通知管理员
						向管理员汇报
						给管理员发消息
						警报
					`),
					ko: termDoc(`
						관리자
						사용자
						관리자에게 알려
						관리자에게 통지
						관리자에게 보고
						관리자에게 메시지 보내
						경고
					`),
					es: termDoc(`
						administrador
						usuario
						avisa al administrador
						informa al administrador
						mensaje al administrador
						envía al administrador
						envia al administrador
						alerta
					`),
					pt: termDoc(`
						administrador
						usuário
						usuario
						avise o administrador
						informe o administrador
						mensagem ao administrador
						envie ao administrador
						alerta
					`),
					vi: termDoc(`
						quản trị viên
						quan tri vien
						người dùng
						nguoi dung
						báo quản trị viên
						bao quan tri vien
						nhắn quản trị viên
						nhan quan tri vien
						cảnh báo
						canh bao
					`),
					tl: termDoc(`
						admin
						user
						sabihin sa admin
						ipaalam sa admin
						i-message ang admin
						iulat
						alerto
					`),
				},
			},
		},
		processKnowledge: {
			request: {
				base: termDoc(`
					process knowledge
					add to knowledge
					upload document
					add document
					learn this
					remember this
					store this
					ingest file
					knowledge base
				`),
				locales: {
					"zh-CN": termDoc(`
						处理知识
						加入知识库
						上传文档
						添加文档
						记住这个
						存入知识库
						知识库
					`),
					ko: termDoc(`
						지식 처리
						지식에 추가
						문서 업로드
						문서 추가
						이걸 기억해
						저장해
						지식 베이스
					`),
					es: termDoc(`
						procesa conocimiento
						agrega al conocimiento
						sube documento
						añade documento
						anade documento
						recuerda esto
						guarda esto
						base de conocimiento
					`),
					pt: termDoc(`
						processar conhecimento
						adicionar ao conhecimento
						enviar documento
						adicionar documento
						lembre isto
						guarde isto
						base de conhecimento
					`),
					vi: termDoc(`
						xử lý kiến thức
						xu ly kien thuc
						thêm vào kiến thức
						them vao kien thuc
						tải tài liệu lên
						tai tai lieu len
						ghi nhớ điều này
						ghi nho dieu nay
					`),
					tl: termDoc(`
						iproseso ang kaalaman
						idagdag sa kaalaman
						mag-upload ng dokumento
						i-save ito
						tandaan ito
						knowledge base
					`),
				},
			},
		},
		searchKnowledge: {
			request: {
				base: termDoc(`
					search knowledge
					find information
					look up
					query knowledge base
					search documents
					find in knowledge
					what do you know about
				`),
				locales: {
					"zh-CN": termDoc(`
						搜索知识
						查找信息
						查询知识库
						搜索文档
						你知道什么关于
					`),
					ko: termDoc(`
						지식 검색
						정보 찾기
						찾아봐
						지식 베이스 조회
						문서 검색
						무엇을 알고 있어
					`),
					es: termDoc(`
						busca conocimiento
						buscar información
						busca información
						busca informacion
						consulta la base de conocimiento
						busca documentos
						qué sabes sobre
						que sabes sobre
					`),
					pt: termDoc(`
						busca conhecimento
						buscar informação
						buscar informacao
						procure informação
						procure informacao
						consulte a base de conhecimento
						o que você sabe sobre
						o que voce sabe sobre
					`),
					vi: termDoc(`
						tìm kiến thức
						tim kien thuc
						tìm thông tin
						tim thong tin
						tra cứu kiến thức
						tra cuu kien thuc
						bạn biết gì về
						ban biet gi ve
					`),
					tl: termDoc(`
						hanapin ang kaalaman
						hanapin ang impormasyon
						tingnan sa knowledge base
						ano ang alam mo tungkol sa
					`),
				},
			},
		},
		generateImage: {
			strong: {
				base: termDoc(`
					generate image
					create image
					make image
					draw
					paint
					illustration
					generate picture
					create picture
					make picture
					generate art
					create art
					image of
					picture of
					photo of
				`),
				locales: {
					"zh-CN": termDoc(`
						生成图片
						创建图片
						画
						绘制
						插画
						图片
						照片
					`),
					ko: termDoc(`
						이미지 생성
						그림 그려
						그려줘
						그림
						일러스트
						사진
					`),
					es: termDoc(`
						genera imagen
						crear imagen
						haz una imagen
						dibuja
						pinta
						ilustración
						ilustracion
						foto de
					`),
					pt: termDoc(`
						gerar imagem
						criar imagem
						faça uma imagem
						faca uma imagem
						desenhe
						pinte
						ilustração
						ilustracao
						foto de
					`),
					vi: termDoc(`
						tạo ảnh
						tao anh
						vẽ
						ve
						minh họa
						minh hoa
						hình ảnh
						hinh anh
					`),
					tl: termDoc(`
						gumawa ng larawan
						lumikha ng larawan
						gumuhit
						pinta
						larawan ng
						photo ng
					`),
				},
			},
			weak: {
				base: termDoc(`
					image
					picture
					visual
					art
					graphic
					render
					generate
					create
					design
					sketch
					portrait
				`),
				locales: {
					"zh-CN": termDoc(`
						图片
						图像
						视觉
						艺术
						设计
						素描
						肖像
					`),
					ko: termDoc(`
						이미지
						사진
						비주얼
						아트
						디자인
						스케치
						초상화
					`),
					es: termDoc(`
						imagen
						foto
						visual
						arte
						gráfico
						grafico
						diseño
						diseno
						boceto
						retrato
					`),
					pt: termDoc(`
						imagem
						foto
						visual
						arte
						gráfico
						grafico
						design
						esboço
						esboco
						retrato
					`),
					vi: termDoc(`
						ảnh
						anh
						hình
						hinh
						thị giác
						thi giac
						nghệ thuật
						nghe thuat
						thiết kế
						thiet ke
					`),
					tl: termDoc(`
						larawan
						biswal
						sining
						disenyo
						sketch
						retrato
					`),
				},
			},
		},
	},
} as const satisfies ValidationKeywordTree;

function isValidationKeywordDoc(value: unknown): value is ValidationKeywordDoc {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as Record<string, unknown>;
	return "base" in record || "locales" in record;
}

function lookupValidationKeywordDoc(key: string): ValidationKeywordDoc {
	let current: unknown = VALIDATION_KEYWORD_DOCS;
	for (const segment of key.split(".")) {
		if (!current || typeof current !== "object") {
			throw new Error(`Unknown validation keyword key: ${key}`);
		}
		current = (current as Record<string, unknown>)[segment];
	}

	if (!isValidationKeywordDoc(current)) {
		throw new Error(`Unknown validation keyword key: ${key}`);
	}

	return current;
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeKeywordMatchText(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function usesAsciiWordBoundaries(term: string): boolean {
	return /^[a-z0-9][a-z0-9' -]*$/i.test(term);
}

export function splitKeywordDoc(value: string | undefined): string[] {
	if (!value) {
		return [];
	}

	const seen = new Set<string>();
	const terms: string[] = [];
	for (const entry of value.split(/\n+/)) {
		const trimmed = entry.trim();
		if (!trimmed) {
			continue;
		}
		const key = normalizeKeywordMatchText(trimmed);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		terms.push(trimmed);
	}
	return terms;
}

export function textIncludesKeywordTerm(text: string, term: string): boolean {
	const normalizedText = normalizeKeywordMatchText(text);
	const normalizedTerm = normalizeKeywordMatchText(term);
	if (!normalizedText || !normalizedTerm) {
		return false;
	}

	if (usesAsciiWordBoundaries(normalizedTerm)) {
		const pattern = new RegExp(
			`\\b${escapePattern(normalizedTerm).replace(/\\ /g, "\\s+")}\\b`,
			"i",
		);
		if (pattern.test(text)) {
			return true;
		}

		const hasNonAsciiText = [...text].some((char) => char.charCodeAt(0) > 0x7f);
		if (hasNonAsciiText) {
			return normalizedText.includes(normalizedTerm);
		}
		return false;
	}

	return normalizedText.includes(normalizedTerm);
}

export function collectKeywordTermMatches(
	texts: readonly string[],
	terms: readonly string[],
): Set<string> {
	const matches = new Set<string>();
	for (const text of texts) {
		for (const term of terms) {
			if (textIncludesKeywordTerm(text, term)) {
				matches.add(term);
			}
		}
	}
	return matches;
}

export function findKeywordTermMatch(
	text: string,
	terms: readonly string[],
): string | undefined {
	const sorted = [...terms].sort((left, right) => right.length - left.length);
	return sorted.find((term) => textIncludesKeywordTerm(text, term));
}

export function getValidationKeywordTerms(
	key: string,
	options?: {
		includeAllLocales?: boolean;
		locale?: ValidationKeywordLocale;
	},
): string[] {
	const doc = lookupValidationKeywordDoc(key);
	if (options?.includeAllLocales) {
		return splitKeywordDoc(
			[doc.base, ...Object.values(doc.locales ?? {})]
				.filter((value): value is string => typeof value === "string")
				.join("\n"),
		);
	}

	return splitKeywordDoc(
		`${doc.base ?? ""}\n${
			options?.locale ? (doc.locales?.[options.locale] ?? "") : ""
		}`,
	);
}
