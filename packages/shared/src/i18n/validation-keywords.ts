import type { CharacterLanguage } from "../contracts/onboarding.js";
import { normalizeCharacterLanguage } from "../onboarding-presets.js";

type ValidationKeywordDoc = {
  base?: string;
  locales?: Partial<Record<CharacterLanguage, string>>;
};

type ValidationKeywordTree = {
  [key: string]: ValidationKeywordTree | ValidationKeywordDoc;
};

function termDoc(value: string): string {
  return value.trim();
}

const VALIDATION_KEYWORD_DOCS = {
  contextSignal: {
    gmail: {
      strong: {
        base: termDoc(`
          email
          emails
          e-mail
          gmail
          inbox
          mailbox
          compose
          draft
          drafts
          unread
          starred
          mail
          message
          messages
          respond to
          reply to
          check my email
          check email
          new mail
          shoot me an email
        `),
        locales: {
          "zh-CN": termDoc(`
            邮件
            电子邮件
            邮箱
            收件箱
            消息
          `),
          ko: termDoc(`
            이메일
            메일
            지메일
            받은편지함
            메시지
            메세지
          `),
          es: termDoc(`
            correo
            correos
            correo electronico
            correo electrónico
            bandeja de entrada
            mensaje
            mensajes
          `),
          pt: termDoc(`
            correio
            correios
            correio eletronico
            correio eletrônico
            caixa de entrada
            mensagem
            mensagens
          `),
          vi: termDoc(`
            thư điện tử
            thu dien tu
            hộp thư
            hop thu
            tin nhắn
          `),
          tl: termDoc(`
            koreo
            liham
            mensahe
          `),
        },
      },
      weak: {
        base: termDoc(`
          send
          reply
          respond
          sender
          subject
          attach
          attachment
          cc
          bcc
          from
          forward
          important
        `),
        locales: {
          "zh-CN": termDoc(`
            发送
            回复
            发件人
            主题
            附件
            抄送
            转发
            重要
          `),
          ko: termDoc(`
            보내기
            답장
            보낸사람
            제목
            첨부
            참조
            전달
            중요
          `),
          es: termDoc(`
            enviar
            responder
            remitente
            asunto
            adjunto
            adjuntar
            reenviar
            importante
          `),
          pt: termDoc(`
            enviar
            responder
            remetente
            assunto
            anexo
            anexar
            encaminhar
            importante
          `),
          vi: termDoc(`
            gửi
            gui
            trả lời
            tra loi
            người gửi
            nguoi gui
            chủ đề
            chu de
            đính kèm
            dinh kem
            chuyển tiếp
            chuyen tiep
          `),
          tl: termDoc(`
            ipadala
            sagot
            nagpadala
            paksa
            kalakip
            ipasa
            mahalaga
          `),
        },
      },
    },
    calendar: {
      strong: {
        base: termDoc(`
          calendar
          event
          events
          flight
          flights
          meeting
          meetings
          appointment
          appointments
          trip
          travel
          itinerary
          agenda
          schedule
          hotel
          hotels
        `),
        locales: {
          "zh-CN": termDoc(`
            日历
            行程
            事件
            活动
            航班
            会议
            约会
            旅行
            差旅
            酒店
            议程
            安排
          `),
          ko: termDoc(`
            캘린더
            일정
            이벤트
            항공편
            비행기
            미팅
            회의
            약속
            여행
            일정표
            호텔
          `),
          es: termDoc(`
            calendario
            evento
            eventos
            vuelo
            vuelos
            reunion
            reunión
            reuniones
            cita
            citas
            viaje
            itinerario
            agenda
            horario
            hotel
            hoteles
          `),
          pt: termDoc(`
            calendario
            evento
            eventos
            voo
            voos
            reuniao
            reunião
            reunioes
            reuniões
            compromisso
            compromissos
            viagem
            itinerario
            itinerário
            agenda
            horario
            horário
            hotel
            hoteis
            hotéis
          `),
          vi: termDoc(`
            lịch
            sự kiện
            cuộc họp
            chuyến bay
            du lịch
            hành trình
            lịch trình
            khách sạn
          `),
          tl: termDoc(`
            kalendaryo
            kaganapan
            lipad
            pulong
            appointment
            biyahe
            itinerary
            iskedyul
            hotel
          `),
        },
      },
      weak: {
        base: termDoc(`
          time
          awake
          sleep
          earlier
          later
          book
          booking
          booked
          check
          free
          busy
          week
          yesterday
          today
          tomorrow
          tonight
          month
          year
        `),
        locales: {
          "zh-CN": termDoc(`
            时间
            早点
            晚点
            预订
            查看
            空闲
            忙
            周
            昨天
            今天
            明天
            今晚
            月
            年
          `),
          ko: termDoc(`
            시간
            일찍
            늦게
            예약
            확인
            한가해
            바빠
            주
            어제
            오늘
            내일
            오늘밤
            달
            년
          `),
          es: termDoc(`
            hora
            temprano
            tarde
            reservar
            reserva
            libre
            ocupado
            semana
            ayer
            hoy
            manana
            mañana
            noche
            mes
            ano
            año
          `),
          pt: termDoc(`
            hora
            cedo
            tarde
            reservar
            reserva
            livre
            ocupado
            semana
            ontem
            hoje
            amanha
            amanhã
            noite
            mes
            mês
            ano
          `),
          vi: termDoc(`
            giờ
            sớm
            muộn
            đặt
            rảnh
            bận
            tuần
            hôm qua
            hôm nay
            ngày mai
            tối nay
            tháng
            năm
          `),
          tl: termDoc(`
            oras
            maaga
            mamaya
            reserba
            libre
            abala
            linggo
            kahapon
            ngayon
            bukas
            gabi
            buwan
            taon
          `),
        },
      },
    },
    web_search: {
      strong: {
        base: termDoc(`
          search
          google
          look up
          look it up
          web search
          search the web
          search online
          search for
          find out
          browse for
        `),
        locales: {
          "zh-CN": termDoc(`
            搜索
            查一下
            查一查
            上网查
            网页搜索
            谷歌
            google
            百度
          `),
          ko: termDoc(`
            검색
            찾아봐
            찾아봐줘
            웹 검색
            구글
            google
          `),
          es: termDoc(`
            buscar
            busca
            googlea
            googlear
            busca en la web
            busca en internet
            investiga
          `),
          pt: termDoc(`
            buscar
            pesquisa
            pesquise
            google
            procura na web
            procura online
          `),
          vi: termDoc(`
            tìm
            tìm kiếm
            tra cứu
            tra cuu
            google
            tìm trên web
          `),
          tl: termDoc(`
            hanapin
            maghanap
            i-google
            google
            hanap sa web
          `),
        },
      },
      weak: {
        base: termDoc(`
          what is
          who is
          when did
          latest
          recent
          news
          current
          today
          how much
          price of
          where is
          find
          research
          check
        `),
        locales: {
          "zh-CN": termDoc(`
            最新
            最近
            新闻
            当前
            今天
            价格
            研究
            查
          `),
          ko: termDoc(`
            최신
            최근
            뉴스
            현재
            오늘
            가격
            조사
            확인
          `),
          es: termDoc(`
            ultimo
            última
            reciente
            noticias
            actual
            hoy
            precio
            investigar
            revisar
          `),
          pt: termDoc(`
            ultimo
            último
            recente
            noticias
            notícias
            atual
            hoje
            preço
            preco
            pesquisar
            conferir
          `),
          vi: termDoc(`
            mới nhất
            gần đây
            tin tức
            hiện tại
            hôm nay
            giá
            nghiên cứu
            kiểm tra
          `),
          tl: termDoc(`
            pinakabago
            kamakailan
            balita
            kasalukuyan
            ngayon
            presyo
            research
            check
          `),
        },
      },
    },
    send_message: {
      strong: {
        base: termDoc(`
          send message
          send a message
          dm
          direct message
          notify
          alert
          tell them
          message them
          reach out
          post to
          post in
        `),
        locales: {
          "zh-CN": termDoc(`
            发消息
            发送消息
            私信
            通知
            提醒
          `),
          ko: termDoc(`
            메시지 보내
            메세지 보내
            쪽지
            디엠
            dm
            알려줘
            전달해
          `),
          es: termDoc(`
            enviar mensaje
            manda mensaje
            mensaje directo
            dm
            notifica
            avisa
          `),
          pt: termDoc(`
            enviar mensagem
            manda mensagem
            mensagem direta
            dm
            notifica
            avisa
          `),
          vi: termDoc(`
            gửi tin nhắn
            gui tin nhan
            nhắn tin
            dm
            thông báo
            nhắc
          `),
          tl: termDoc(`
            magpadala ng mensahe
            padalhan ng mensahe
            dm
            direktang mensahe
            abisuhan
          `),
        },
      },
      weak: {
        base: termDoc(`
          send
          message
          tell
          notify
          alert
          admin
          owner
          urgent
          escalate
          channel
          room
        `),
        locales: {
          "zh-CN": termDoc(`
            发送
            消息
            通知
            提醒
            管理员
            owner
            紧急
            频道
            房间
          `),
          ko: termDoc(`
            보내
            메시지
            알림
            관리자
            owner
            긴급
            채널
            방
          `),
          es: termDoc(`
            enviar
            mensaje
            avisar
            notificar
            alerta
            admin
            owner
            urgente
            canal
            sala
          `),
          pt: termDoc(`
            enviar
            mensagem
            avisar
            notificar
            alerta
            admin
            owner
            urgente
            canal
            sala
          `),
          vi: termDoc(`
            gửi
            tin nhắn
            thông báo
            khẩn cấp
            kênh
            phòng
          `),
          tl: termDoc(`
            padala
            mensahe
            abiso
            alerto
            admin
            owner
            urgent
            channel
            room
          `),
        },
      },
    },
    send_admin_message: {
      strong: {
        base: termDoc(`
          message admin
          notify owner
          alert admin
          tell admin
          tell owner
          escalate
        `),
        locales: {
          "zh-CN": termDoc(`
            通知管理员
            告诉管理员
            通知 owner
            升级处理
          `),
          ko: termDoc(`
            관리자에게 알려
            관리자한테 말해
            owner에게 알려
            에스컬레이션
          `),
          es: termDoc(`
            avisar al admin
            avisar al owner
            decirle al admin
            escalar
          `),
          pt: termDoc(`
            avisar o admin
            avisar o owner
            falar com o admin
            escalar
          `),
          vi: termDoc(`
            báo admin
            bao admin
            báo owner
            leo thang
          `),
          tl: termDoc(`
            sabihan ang admin
            abisuhan ang owner
            i-escalate
          `),
        },
      },
      weak: {
        base: termDoc(`
          admin
          owner
          notify
          alert
          urgent
          escalate
          important
        `),
        locales: {
          "zh-CN": termDoc(`
            管理员
            owner
            通知
            提醒
            紧急
            升级
            重要
          `),
          ko: termDoc(`
            관리자
            owner
            알림
            긴급
            중요
            에스컬레이션
          `),
          es: termDoc(`
            admin
            owner
            avisar
            alerta
            urgente
            escalar
            importante
          `),
          pt: termDoc(`
            admin
            owner
            avisar
            alerta
            urgente
            escalar
            importante
          `),
          vi: termDoc(`
            admin
            owner
            báo
            khẩn cấp
            quan trọng
          `),
          tl: termDoc(`
            admin
            owner
            abiso
            urgent
            importante
            escalate
          `),
        },
      },
    },
    search_conversations: {
      strong: {
        base: termDoc(`
          search conversations
          search chats
          search messages
          find messages
          find conversation
        `),
        locales: {
          "zh-CN": termDoc(`
            搜索对话
            搜索聊天
            搜索消息
            查找消息
          `),
          ko: termDoc(`
            대화 검색
            채팅 검색
            메시지 검색
            메시지 찾기
          `),
          es: termDoc(`
            buscar conversaciones
            buscar chats
            buscar mensajes
            encontrar mensajes
          `),
          pt: termDoc(`
            buscar conversas
            buscar chats
            buscar mensagens
            encontrar mensagens
          `),
          vi: termDoc(`
            tìm cuộc trò chuyện
            tìm tin nhắn
            tra cứu cuộc trò chuyện
          `),
          tl: termDoc(`
            hanapin ang usapan
            hanapin ang chat
            hanapin ang mensahe
          `),
        },
      },
      weak: {
        base: termDoc(`
          search
          find
          recall
          remember
          said
          mentioned
          talked about
          discussed
          earlier
          previously
          conversation
        `),
        locales: {
          "zh-CN": termDoc(`
            搜索
            查找
            记得
            提到
            聊过
            之前
            对话
          `),
          ko: termDoc(`
            검색
            찾기
            기억
            말했
            언급
            이전
            대화
          `),
          es: termDoc(`
            buscar
            encontrar
            recordar
            dijiste
            mencionaste
            antes
            conversación
            conversacion
          `),
          pt: termDoc(`
            buscar
            encontrar
            lembrar
            falou
            mencionou
            antes
            conversa
          `),
          vi: termDoc(`
            tìm
            nhớ
            nói
            nhắc
            trước đó
            cuộc trò chuyện
          `),
          tl: termDoc(`
            hanap
            tandaan
            sinabi
            nabanggit
            dati
            usapan
          `),
        },
      },
    },
    read_channel: {
      strong: {
        base: termDoc(`
          read channel
          read chat
          read messages
          channel history
          chat history
          chat log
          message history
          scroll back
          read room
        `),
        locales: {
          "zh-CN": termDoc(`
            读取频道
            查看聊天
            查看消息记录
            频道历史
            聊天记录
          `),
          ko: termDoc(`
            채널 읽기
            채팅 읽기
            메시지 기록
            채널 기록
            채팅 기록
          `),
          es: termDoc(`
            leer canal
            leer chat
            historial del canal
            historial del chat
            registro del chat
          `),
          pt: termDoc(`
            ler canal
            ler chat
            histórico do canal
            histórico do chat
            registro do chat
          `),
          vi: termDoc(`
            đọc kênh
            đọc chat
            lịch sử kênh
            lịch sử chat
          `),
          tl: termDoc(`
            basahin ang channel
            basahin ang chat
            history ng channel
            history ng chat
          `),
        },
      },
      weak: {
        base: termDoc(`
          channel
          chat
          history
          messages
          conversation
          read
          room
          log
          recent
          earlier
        `),
        locales: {
          "zh-CN": termDoc(`
            频道
            聊天
            历史
            消息
            对话
            查看
            房间
            最近
            之前
          `),
          ko: termDoc(`
            채널
            채팅
            기록
            메시지
            대화
            읽기
            방
            최근
            이전
          `),
          es: termDoc(`
            canal
            chat
            historial
            mensajes
            conversación
            conversacion
            leer
            sala
            reciente
            antes
          `),
          pt: termDoc(`
            canal
            chat
            histórico
            historico
            mensagens
            conversa
            ler
            sala
            recente
            antes
          `),
          vi: termDoc(`
            kênh
            chat
            lịch sử
            tin nhắn
            cuộc trò chuyện
            đọc
            phòng
            gần đây
            trước đó
          `),
          tl: termDoc(`
            channel
            chat
            history
            mensahe
            usapan
            basahin
            room
            recent
            earlier
          `),
        },
      },
    },
    stream_control: {
      strong: {
        base: termDoc(`
          go live
          go offline
          start stream
          stop stream
          start streaming
          stop streaming
          begin stream
          end stream
        `),
        locales: {
          "zh-CN": termDoc(`
            开播
            下播
            开始直播
            停止直播
          `),
          ko: termDoc(`
            방송 시작
            방송 종료
            라이브 시작
            라이브 종료
          `),
          es: termDoc(`
            salir en vivo
            terminar stream
            iniciar stream
            detener stream
          `),
          pt: termDoc(`
            entrar ao vivo
            encerrar stream
            iniciar stream
            parar stream
          `),
          vi: termDoc(`
            lên sóng
            ket thuc stream
            kết thúc stream
            bắt đầu stream
            bat dau stream
          `),
          tl: termDoc(`
            mag live
            tapusin ang stream
            simulan ang stream
            ihinto ang stream
          `),
        },
      },
      weak: {
        base: termDoc(`
          live
          stream
          streaming
          broadcast
          twitch
          youtube
          offline
          online
        `),
        locales: {
          "zh-CN": termDoc(`
            直播
            开播
            下播
            在线
            离线
            twitch
            youtube
          `),
          ko: termDoc(`
            라이브
            스트림
            스트리밍
            방송
            트위치
            유튜브
            오프라인
            온라인
          `),
          es: termDoc(`
            vivo
            stream
            streaming
            transmisión
            transmision
            twitch
            youtube
            offline
            online
          `),
          pt: termDoc(`
            ao vivo
            stream
            streaming
            transmissão
            transmissao
            twitch
            youtube
            offline
            online
          `),
          vi: termDoc(`
            stream
            phát sóng
            phat song
            trực tiếp
            twitch
            youtube
            offline
            online
          `),
          tl: termDoc(`
            live
            stream
            streaming
            broadcast
            twitch
            youtube
            offline
            online
          `),
        },
      },
    },
    search_entity: {
      strong: {
        base: termDoc(`
          search entity
          find person
          lookup user
          search contacts
          search rolodex
          who is
          contact details
          view person
          get contact
        `),
        locales: {
          "zh-CN": termDoc(`
            查找联系人
            查人
            搜索联系人
            谁是
            查看资料
          `),
          ko: termDoc(`
            사람 찾기
            연락처 검색
            사용자 조회
            누구야
            프로필 보기
          `),
          es: termDoc(`
            buscar persona
            encontrar persona
            buscar contactos
            quien es
            quién es
            ver perfil
          `),
          pt: termDoc(`
            buscar pessoa
            encontrar pessoa
            buscar contatos
            quem é
            quem e
            ver perfil
          `),
          vi: termDoc(`
            tìm người
            tìm liên hệ
            tra người dùng
            ai là
            xem hồ sơ
          `),
          tl: termDoc(`
            hanapin ang tao
            hanapin ang contact
            sino si
            tingnan ang profile
          `),
        },
      },
      weak: {
        base: termDoc(`
          person
          contact
          entity
          user
          lookup
          who
          profile
          identity
          rolodex
          details
        `),
        locales: {
          "zh-CN": termDoc(`
            联系人
            用户
            谁
            档案
            身份
            详情
          `),
          ko: termDoc(`
            사람
            연락처
            사용자
            누구
            프로필
            신원
            정보
          `),
          es: termDoc(`
            persona
            contacto
            usuario
            quien
            quién
            perfil
            identidad
            detalles
          `),
          pt: termDoc(`
            pessoa
            contato
            usuário
            usuario
            quem
            perfil
            identidade
            detalhes
          `),
          vi: termDoc(`
            người
            liên hệ
            người dùng
            ai
            hồ sơ
            danh tính
            chi tiết
          `),
          tl: termDoc(`
            tao
            contact
            user
            sino
            profile
            identity
            details
          `),
        },
      },
    },
    lifeops: {
      strong: {
        base: termDoc(`
          todo
          to-do
          to do
          task
          habit
          routine
          reminder
          alarm
          goal
          track
          streak
          lifeops
          life ops
          workout
          exercise
          meditation
          checklist
          self-care
          wellness
          accountability
        `),
        locales: {
          "zh-CN": termDoc(`
            待办
            代办事项
            待办事项
            任务
            习惯
            日程
            提醒
            闹钟
            目标
            打卡
            签到
            追踪
            锻炼
            健身
            冥想
            自律
            早起
          `),
          ko: termDoc(`
            할일
            할 일
            과제
            습관
            루틴
            알림
            알람
            목표
            추적
            스트릭
            운동
            명상
            투두
            체크리스트
            스케줄
            리마인더
            자기관리
          `),
          es: termDoc(`
            tarea
            tareas
            habito
            hábito
            rutina
            recordatorio
            alarma
            meta
            metas
            objetivo
            seguimiento
            rastrear
            pendiente
            pendientes
            ejercicio
            entrenamiento
            meditación
            meditacion
            racha
            lista de tareas
            quehacer
            quehaceres
          `),
          pt: termDoc(`
            tarefa
            tarefas
            habito
            hábito
            rotina
            lembrete
            alarme
            meta
            metas
            objetivo
            acompanhamento
            rastrear
            exercício
            exercicio
            treino
            meditação
            meditacao
            sequência
            sequencia
            lista de tarefas
            afazer
            afazeres
            pendência
            pendencia
          `),
          vi: termDoc(`
            việc cần làm
            viec can lam
            nhiệm vụ
            nhiem vu
            thói quen
            thoi quen
            nhắc nhở
            nhac nho
            chuông báo
            chuong bao
            mục tiêu
            muc tieu
            theo dõi
            theo doi
            tập thể dục
            tap the duc
            thiền
            thien
          `),
          tl: termDoc(`
            gawain
            gawi
            rutina
            paalala
            alarma
            layunin
            subaybay
            ehersisyo
            meditasyon
            listahan
            tsek
            workout
            goal
            reminder
            task
          `),
        },
      },
      weak: {
        base: termDoc(`
          done
          finished
          completed
          skip
          snooze
          later
          postpone
          defer
          mark
          check off
          delete
          remove
          cancel
          update
          change
          edit
          modify
          overview
          summary
          status
          progress
          active
          what do i have
          what's left
        `),
        locales: {
          "zh-CN": termDoc(`
            完成
            做完了
            跳过
            推迟
            稍后
            延迟
            标记
            删除
            移除
            取消
            更新
            修改
            编辑
            概览
            摘要
            状态
            进度
            活跃
          `),
          ko: termDoc(`
            완료
            끝났어
            건너뛰기
            나중에
            미루기
            연기
            표시
            삭제
            제거
            취소
            수정
            변경
            편집
            개요
            요약
            상태
            진행
            활성
          `),
          es: termDoc(`
            hecho
            terminado
            completado
            omitir
            saltar
            posponer
            aplazar
            despues
            después
            marcar
            eliminar
            quitar
            cancelar
            actualizar
            cambiar
            editar
            modificar
            resumen
            estado
            progreso
            activo
          `),
          pt: termDoc(`
            feito
            terminado
            concluido
            concluído
            pular
            adiar
            depois
            marcar
            excluir
            remover
            cancelar
            atualizar
            alterar
            editar
            modificar
            resumo
            estado
            progresso
            ativo
          `),
          vi: termDoc(`
            xong
            hoàn thành
            bỏ qua
            để sau
            hoãn
            đánh dấu
            xóa
            hủy
            cập nhật
            thay đổi
            sửa
            tổng quan
            tóm tắt
            trạng thái
            tiến độ
          `),
          tl: termDoc(`
            tapos
            natapos
            laktawan
            mamaya
            ipagpaliban
            markahan
            tanggalin
            alisin
            kanselahin
            baguhin
            i-edit
            buod
            estado
            progreso
            aktibo
          `),
        },
      },
    },
    lifeops_complete: {
      strong: {
        base: termDoc(`
          done
          finished
          completed
          did it
          did that
          did my
          did the
          mark done
          mark complete
          mark as done
          checked off
          ticked off
          crossed off
          just finished
          just completed
          just did
          i already
          i've done
          i have done
          all done
          got it done
          took care of it
          knocked it out
          crushed it
          nailed it
          handled it
          accomplished
          yep done
        `),
        locales: {
          "zh-CN": termDoc(`
            完成了
            做完了
            已完成
            搞定了
            搞定
            弄好了
            做好了
            打卡
            已做
            OK了
            完事了
            好了
            办完了
            整完了
          `),
          ko: termDoc(`
            했어
            했어요
            완료
            끝났어
            끝냈어
            다했어
            다 했어
            마쳤어
            체크
            끝
            했습니다
            완료했어
            완료했습니다
            해냈어
            클리어
            했지
          `),
          es: termDoc(`
            hecho
            listo
            terminé
            termine
            terminado
            completé
            complete
            completado
            ya lo hice
            ya hice
            marcar hecho
            marcar completo
            ya
            ya está
            ya esta
            lo hice
            lo terminé
            lo termine
            acabé
            acabe
            cumplido
            dale
          `),
          pt: termDoc(`
            feito
            pronto
            terminei
            terminado
            completei
            concluí
            conclui
            concluído
            concluido
            já fiz
            ja fiz
            marcar feito
            marcar concluído
            tá feito
            ta feito
            fiz
            acabei
            beleza
            tá pronto
            ta pronto
            resolvido
            finalizado
          `),
          vi: termDoc(`
            xong rồi
            xong roi
            đã xong
            da xong
            hoàn thành rồi
            hoan thanh roi
            đã làm
            da lam
            đánh dấu xong
            danh dau xong
            xong
            làm rồi
            lam roi
            ok rồi
            ok roi
            xử lý xong
            xu ly xong
          `),
          tl: termDoc(`
            tapos na
            natapos na
            ginawa ko na
            natapos ko
            markahang tapos
            ayos na
            okay na
            done na
            tapos ko na
            goods na
          `),
        },
      },
    },
    lifeops_skip: {
      strong: {
        base: termDoc(`
          skip
          pass on
          not today
          skip today
          skip this
          nah
          pass
          nope
          not doing it
          not gonna
          gonna skip
          can't today
          not this time
          hard pass
          no thanks
        `),
        locales: {
          "zh-CN": termDoc(`
            跳过
            今天不做
            今天跳过
            算了
            不了
            不想做
            懒得做
            免了
            不做了
            放弃
          `),
          ko: termDoc(`
            건너뛰기
            오늘 안 해
            오늘은 패스
            패스
            스킵
            안 할래
            됐어
            안 해
            귀찮아
            넘어가
          `),
          es: termDoc(`
            omitir
            saltar
            hoy no
            paso
            pasar
            nah
            no quiero
            dejalo
            déjalo
            paso de eso
            nel
            que va
          `),
          pt: termDoc(`
            pular
            hoje não
            hoje nao
            passar
            deixa pra lá
            deixa pra la
            não quero
            nao quero
            nah
            nem
            to fora
            próximo
            proximo
          `),
          vi: termDoc(`
            bỏ qua
            bo qua
            hôm nay không
            hom nay khong
            thôi
            thoi
            khỏi
            khoi
            không làm
            khong lam
            bỏ đi
            bo di
          `),
          tl: termDoc(`
            laktawan
            hindi ngayon
            pasa
            skip
            ayaw ko
            wag na
            di ko gagawin
          `),
        },
      },
    },
    lifeops_snooze: {
      strong: {
        base: termDoc(`
          snooze
          remind me later
          remind me again
          postpone
          defer
          push back
          push it back
          push that back
          put off
          put it off
          put that off
          in a bit
          hold off
          not right now
          maybe later
          not yet
          come back later
          ask me again
          give me a minute
        `),
        locales: {
          "zh-CN": termDoc(`
            推迟
            稍后
            晚点再说
            等下提醒
            延后
            延迟
            一会儿再说
            先不急
            别急
            缓缓
            等等
            明天再说
            过一会儿
          `),
          ko: termDoc(`
            나중에
            미루기
            다시 알려줘
            나중에 알려줘
            연기
            미루다
            잠깐
            조금 뒤에
            이따가
            좀 있다가
            잠시만
          `),
          es: termDoc(`
            posponer
            aplazar
            más tarde
            mas tarde
            después
            despues
            recuérdame después
            recuerdame despues
            ahora no
            ahorita no
            ahorita
            en un rato
            luego
            al rato
            un momento
          `),
          pt: termDoc(`
            adiar
            mais tarde
            depois
            lembrar depois
            postergar
            agora não
            agora nao
            daqui a pouco
            já já
            ja ja
            peraí
            perai
            calma
            espera
          `),
          vi: termDoc(`
            để sau
            de sau
            hoãn
            hoan
            nhắc lại sau
            nhac lai sau
            chờ chút
            cho chut
            chưa
            chua
            từ từ
            tu tu
            lát nữa
            lat nua
            tí nữa
            ti nua
          `),
          tl: termDoc(`
            mamaya
            ipagpaliban
            ipaalala mamaya
            mamaya na lang
            sandali lang
            saglit
            di muna
            hindi pa
            maya-maya
            later
          `),
        },
      },
    },
    lifeops_delete: {
      strong: {
        base: termDoc(`
          delete
          remove
          cancel
          get rid of
          drop
          stop tracking
          stop the
          stop my
          ditch
          scrap
          nuke it
          kill it
          trash
          toss
          forget about
          forget it
          never mind
          no longer need
          don't need this
          don't want this
        `),
        locales: {
          "zh-CN": termDoc(`
            删除
            移除
            取消
            不要了
            停止追踪
            停止跟踪
            去掉
            扔掉
            不做了
            不需要了
            干掉
          `),
          ko: termDoc(`
            삭제
            제거
            취소
            없애줘
            추적 중지
            그만 추적
            지워줘
            버려
            필요 없어
            그만
            빼줘
            캔슬
          `),
          es: termDoc(`
            eliminar
            quitar
            borrar
            cancelar
            dejar de rastrear
            dejar de seguir
            borra
            olvídate
            olvidate
            no necesito
            ya no quiero
            sácalo
            sacalo
            tíralo
            tiralo
          `),
          pt: termDoc(`
            excluir
            deletar
            remover
            cancelar
            parar de rastrear
            parar de acompanhar
            apagar
            apaga
            joga fora
            tira
            não preciso
            nao preciso
            não quero mais
            nao quero mais
            esquece
          `),
          vi: termDoc(`
            xóa
            xoa
            hủy
            huy
            bỏ
            bo
            ngừng theo dõi
            ngung theo doi
            gỡ
            go
            bỏ đi
            bo di
            không cần nữa
            khong can nua
            quên đi
            quen di
          `),
          tl: termDoc(`
            tanggalin
            alisin
            kanselahin
            itigil ang pagsubaybay
            delete
            itapon
            di ko na kailangan
            kalimutan na
            wag na
          `),
        },
      },
    },
    lifeops_update: {
      strong: {
        base: termDoc(`
          update
          change
          edit
          modify
          adjust
          rename
          reschedule
          tweak
          fix
          switch
          move
          set to
          swap
          revise
        `),
        locales: {
          "zh-CN": termDoc(`
            更新
            修改
            编辑
            调整
            重命名
            改时间
            重新安排
            改
            换
            改成
            换成
            微调
          `),
          ko: termDoc(`
            수정
            변경
            편집
            조정
            이름 바꾸기
            일정 변경
            바꿔줘
            고쳐줘
            바꿔
            고쳐
            옮기기
            업데이트
          `),
          es: termDoc(`
            actualizar
            cambiar
            editar
            modificar
            ajustar
            renombrar
            reprogramar
            arreglar
            arregla
            mover
            cámbialo
            cambialo
            corregir
            ponle
          `),
          pt: termDoc(`
            atualizar
            alterar
            editar
            modificar
            ajustar
            renomear
            reagendar
            arrumar
            arruma
            mudar
            muda
            trocar
            troca
            mexer
            corrigir
          `),
          vi: termDoc(`
            cập nhật
            cap nhat
            thay đổi
            thay doi
            sửa
            sua
            điều chỉnh
            dieu chinh
            đổi tên
            doi ten
            đổi lịch
            doi lich
            chỉnh
            chinh
            đổi
            doi
            dời
            doi
          `),
          tl: termDoc(`
            baguhin
            i-edit
            i-adjust
            palitan ang pangalan
            palitan ang iskedyul
            update
            change
            ayusin
            ilipat
          `),
        },
      },
    },
    lifeops_reminder_pref: {
      strong: {
        base: termDoc(`
          stop reminding me
          don't remind me
          pause reminders
          resume reminders
          more reminders
          less reminders
          fewer reminders
          normal reminders
          mute reminders
          high priority only
          only high priority
          be more persistent
          more persistent
          remind me less
          remind me more
          remind less
          remind more
          start reminding me again
          turn reminders back on
          stop nagging
          quit bugging me
          enough reminders
          too many reminders
          chill with the reminders
          bug me more
          nag me about
          keep on me about
          stay on top of me
        `),
        locales: {
          "zh-CN": termDoc(`
            停止提醒
            别提醒了
            暂停提醒
            恢复提醒
            多提醒
            少提醒
            静音提醒
            仅高优先
            别烦我
            别催了
            多催催
            盯着我
          `),
          ko: termDoc(`
            알림 중지
            알림 그만
            알림 일시 중지
            알림 재개
            알림 더
            알림 줄여
            알림 음소거
            높은 우선순위만
            좀 그만
            자꾸 알려줘
            계속 알려줘
            잔소리 그만
          `),
          es: termDoc(`
            dejar de recordarme
            no me recuerdes
            pausar recordatorios
            reanudar recordatorios
            más recordatorios
            mas recordatorios
            menos recordatorios
            recordatorios normales
            silenciar recordatorios
            solo prioridad alta
            deja de molestar
            no me molestes
            ya basta de recordatorios
            insísteme
            insisteme
          `),
          pt: termDoc(`
            parar de lembrar
            não me lembre
            nao me lembre
            pausar lembretes
            retomar lembretes
            mais lembretes
            menos lembretes
            lembretes normais
            silenciar lembretes
            apenas alta prioridade
            para de encher
            chega de lembrete
            me cobra mais
            insiste mais
          `),
          vi: termDoc(`
            ngừng nhắc
            ngung nhac
            đừng nhắc
            dung nhac
            tạm dừng nhắc
            tam dung nhac
            tiếp tục nhắc
            tiep tuc nhac
            nhắc nhiều hơn
            nhac nhieu hon
            nhắc ít hơn
            nhac it hon
            tắt nhắc
            tat nhac
            đủ rồi
            du roi
          `),
          tl: termDoc(`
            itigil ang paalala
            huwag na akong paalalahanan
            i-pause ang paalala
            ituloy ang paalala
            dagdagan ang paalala
            bawasan ang paalala
            tama na
            stop na
            tigilan mo na
          `),
        },
      },
    },
    lifeops_overview: {
      strong: {
        base: termDoc(`
          overview
          summary
          what's active
          what is active
          status
          what do i have
          show me everything
          what's left
          what is left
          still left
          what do i still need
          anything else to do
          need to get done
          need to finish
          get done today
          anything else
          still need to do
          what's on my plate
          what am i juggling
          where do things stand
          give me the rundown
          catch me up
          what's pending
          what's outstanding
          show my tasks
          my list
          my tasks
          how many tasks
          list everything
        `),
        locales: {
          "zh-CN": termDoc(`
            概览
            总结
            摘要
            状态
            还有什么
            剩余任务
            活跃任务
            我还要做什么
            都有啥
            看一下
            我的任务
            还剩什么
            有什么要做的
          `),
          ko: termDoc(`
            개요
            요약
            상태
            뭐 남았어
            남은 거
            활성 항목
            아직 할 거
            뭐 해야 돼
            뭐 해야 해
            할 일 목록
            얼마나 남았어
            보여줘
          `),
          es: termDoc(`
            resumen
            estado
            que me queda
            qué me queda
            que tengo
            qué tengo
            mostrar todo
            tareas activas
            qué hay pendiente
            que hay pendiente
            mis tareas
            mi lista
            qué falta
            que falta
            en qué ando
            en que ando
          `),
          pt: termDoc(`
            resumo
            estado
            o que falta
            o que tenho
            mostrar tudo
            tarefas ativas
            o que tem pendente
            minhas tarefas
            minha lista
            quanto falta
            cadê minhas coisas
            cade minhas coisas
          `),
          vi: termDoc(`
            tổng quan
            tong quan
            tóm tắt
            tom tat
            trạng thái
            trang thai
            còn gì
            con gi
            còn gì nữa
            con gi nua
            việc đang làm
            viec dang lam
            danh sách
            danh sach
            cho xem
            có gì
            co gi
          `),
          tl: termDoc(`
            buod
            estado
            ano pa ang natitira
            ipakita lahat
            mga aktibong gawain
            ano ang mga gawain ko
            lista ko
            anong meron
            show
          `),
        },
      },
    },
    lifeops_cadence: {
      strong: {
        base: termDoc(`
          every day
          everyday
          daily
          weekly
          monthly
          weekdays
          weekends
          each day
          each morning
          each night
          each week
          each month
          every week
          every month
          every morning
          every afternoon
          every evening
          every night
          twice a day
          per day
          per week
          throughout the day
          with lunch
          with breakfast
          with dinner
          times a day
          times per day
          times a week
          once a day
          once a week
          before bed
          after work
          when i wake up
          first thing in the morning
          at night
          in the morning
          on mondays
          on tuesdays
          on wednesdays
          on thursdays
          on fridays
          on saturdays
          on sundays
        `),
        locales: {
          "zh-CN": termDoc(`
            每天
            每日
            每周
            每月
            工作日
            周末
            每个早上
            每个下午
            每个晚上
            一天两次
            每天一次
            起床后
            睡前
            下班后
            上班前
            隔天
            每隔一天
            一周三次
          `),
          ko: termDoc(`
            매일
            매주
            매월
            평일
            주말
            매일 아침
            매일 저녁
            하루에 두 번
            하루에 한 번
            일어나면
            자기 전에
            퇴근 후
            출근 전
            격일
            주 3회
            월수금
            일주일에 한 번
          `),
          es: termDoc(`
            cada día
            cada dia
            diario
            diariamente
            semanal
            semanalmente
            mensual
            mensualmente
            entre semana
            fin de semana
            fines de semana
            cada mañana
            cada tarde
            cada noche
            dos veces al día
            dos veces al dia
            por día
            por dia
            antes de dormir
            al despertar
            después del trabajo
            despues del trabajo
            lunes a viernes
            todos los días
            todos los dias
            cada rato
          `),
          pt: termDoc(`
            todo dia
            todos os dias
            diário
            diario
            diariamente
            semanal
            semanalmente
            mensal
            mensalmente
            dia de semana
            fim de semana
            toda manhã
            toda manha
            toda tarde
            toda noite
            duas vezes ao dia
            por dia
            antes de dormir
            ao acordar
            depois do trabalho
            segunda a sexta
            dia sim dia não
            dia sim dia nao
          `),
          vi: termDoc(`
            mỗi ngày
            moi ngay
            hàng ngày
            hang ngay
            hàng tuần
            hang tuan
            hàng tháng
            hang thang
            ngày trong tuần
            cuối tuần
            cuoi tuan
            mỗi sáng
            moi sang
            mỗi chiều
            moi chieu
            mỗi tối
            moi toi
            hai lần mỗi ngày
            trước khi ngủ
            truoc khi ngu
            khi thức dậy
            khi thuc day
            sau giờ làm
            sau gio lam
            cách ngày
            cach ngay
          `),
          tl: termDoc(`
            araw-araw
            lingguhan
            buwanan
            weekdays
            weekends
            tuwing umaga
            tuwing hapon
            tuwing gabi
            dalawang beses sa isang araw
            bago matulog
            pagkagising
            pagkatapos ng trabaho
            everyday
            daily
          `),
        },
      },
    },
    lifeops_goal: {
      strong: {
        base: termDoc(`
          goal
          goals
          aspiration
          life goal
          achieve
          aim
          target
          ambition
          milestone
          objective
          dream
          bucket list
          resolution
          i want to
          i wanna
          working toward
          working towards
          strive
          vision
          purpose
          intention
        `),
        locales: {
          "zh-CN": termDoc(`
            目标
            志向
            梦想
            愿望
            里程碑
            想要
            追求
            心愿
            计划
            努力
            愿景
          `),
          ko: termDoc(`
            목표
            꿈
            포부
            야망
            이정표
            하고 싶다
            되고 싶다
            비전
            계획
            다짐
            버킷리스트
          `),
          es: termDoc(`
            meta
            metas
            objetivo
            objetivos
            aspiración
            aspiracion
            lograr
            sueño
            ambición
            ambicion
            quiero
            propósito
            proposito
            resolución
            resolucion
            plan
          `),
          pt: termDoc(`
            meta
            metas
            objetivo
            objetivos
            aspiração
            aspiracao
            alcançar
            alcancar
            sonho
            ambição
            ambicao
            quero
            propósito
            proposito
            resolução
            resolucao
            plano
          `),
          vi: termDoc(`
            mục tiêu
            muc tieu
            ước mơ
            uoc mo
            hoài bão
            hoai bao
            khát vọng
            khat vong
            muốn
            muon
            quyết tâm
            quyet tam
            kế hoạch
            ke hoach
          `),
          tl: termDoc(`
            layunin
            pangarap
            ambisyon
            mithiin
            gusto ko
            plano
            resolusyon
            goal
            bucket list
          `),
        },
      },
    },
    lifeops_escalation: {
      strong: {
        base: termDoc(`
          escalate
          escalation
          reminder plan
          set up sms
          set up text
          set up voice
          notify if
          text me if
          call me if
          sms if
          text if i ignore
          text if i miss
          call if i ignore
          call if i miss
          text me if i ignore
          text me if i miss
          call me if i ignore
          call me if i miss
          nag me
          bug me
          keep bugging me
          blow up my phone
          ping me
          if i don't respond
          if i don't do it
        `),
        locales: {
          "zh-CN": termDoc(`
            升级
            升级提醒
            设置短信
            设置语音
            如果忽略就发短信
            如果忽略就打电话
            催我
            盯紧
            如果我不做
            如果我不回复
          `),
          ko: termDoc(`
            에스컬레이션
            알림 계획
            문자 설정
            음성 설정
            무시하면 문자
            무시하면 전화
            계속 알려줘
            안 하면 문자해
            잔소리해줘
          `),
          es: termDoc(`
            escalar
            escalación
            escalacion
            plan de recordatorio
            configurar sms
            configurar texto
            configurar voz
            notificar si
            enviar texto si ignoro
            llamar si ignoro
            insísteme
            insisteme
            si no respondo
            si no lo hago
          `),
          pt: termDoc(`
            escalar
            escalação
            escalacao
            plano de lembrete
            configurar sms
            configurar texto
            configurar voz
            notificar se
            enviar mensagem se ignorar
            ligar se ignorar
            me cobre
            se eu não fizer
            se eu nao fizer
          `),
          vi: termDoc(`
            leo thang
            kế hoạch nhắc nhở
            ke hoach nhac nho
            thiết lập sms
            thiet lap sms
            nhắn tin nếu bỏ lỡ
            nhan tin neu bo lo
            gọi nếu bỏ lỡ
            goi neu bo lo
          `),
          tl: termDoc(`
            i-escalate
            plano ng paalala
            i-setup ang sms
            i-text kung hindi pinansin
            tawagan kung hindi pinansin
            pag hindi ko ginawa
            kulitin mo ako
            text mo ako
          `),
        },
      },
    },
    lifeops_phone: {
      strong: {
        base: termDoc(`
          phone
          text me
          call me
          sms
          my number
          voice call
          my phone number
          phone number
          txt me
          ring me
          my cell
          mobile
          my mobile
          whatsapp me
          whatsapp
        `),
        locales: {
          "zh-CN": termDoc(`
            电话
            给我发短信
            打给我
            短信
            我的号码
            我的电话号码
            手机
            手机号
            微信
          `),
          ko: termDoc(`
            전화
            문자 보내줘
            전화해줘
            내 번호
            내 전화번호
            핸드폰
            휴대폰
            폰
            카톡
            카카오톡
          `),
          es: termDoc(`
            teléfono
            telefono
            envíame un mensaje
            mandame un mensaje
            llámame
            llamame
            sms
            mi número
            mi numero
            celular
            cel
            mi cel
            móvil
            movil
            whatsapp
          `),
          pt: termDoc(`
            telefone
            me mande mensagem
            me ligue
            sms
            meu número
            meu numero
            celular
            cel
            meu cel
            whatsapp
            zap
            me zapa
          `),
          vi: termDoc(`
            điện thoại
            dien thoai
            nhắn tin cho tôi
            nhan tin cho toi
            gọi cho tôi
            goi cho toi
            số của tôi
            so cua toi
            số điện thoại
            so dien thoai
            di động
            di dong
            zalo
          `),
          tl: termDoc(`
            telepono
            i-text ako
            tawagan ako
            sms
            numero ko
            cellphone
            cp
            number ko
            viber
          `),
        },
      },
    },
    lifeops_review: {
      strong: {
        base: termDoc(`
          review
          how am i doing
          how's it going
          how'd i do
          progress
          check on
          check goal
          check my goal
          progress report
          am i on track
          am i keeping up
          where am i at
          recap
          streak check
          goal check
          habit check
        `),
        locales: {
          "zh-CN": termDoc(`
            回顾
            进展如何
            检查进度
            查看目标
            我做得怎么样
            看看进度
            怎么样了
            表现如何
            坚持得怎样
          `),
          ko: termDoc(`
            리뷰
            어떻게 하고 있어
            진행 상황
            목표 확인
            잘 하고 있어
            얼마나 했어
            성과
            습관 체크
            스트릭 확인
          `),
          es: termDoc(`
            revisar
            cómo voy
            como voy
            progreso
            revisar meta
            revisar objetivo
            cómo me fue
            como me fue
            estoy en buen camino
            mi racha
            cómo llevo
            como llevo
          `),
          pt: termDoc(`
            revisar
            como estou indo
            progresso
            verificar meta
            verificar objetivo
            como fui
            estou no caminho certo
            minha sequência
            minha sequencia
            como tá indo
            como ta indo
          `),
          vi: termDoc(`
            xem lại
            xem lai
            tiến triển thế nào
            tien trien the nao
            tiến độ
            tien do
            kiểm tra mục tiêu
            kiem tra muc tieu
            kết quả
            ket qua
            đánh giá
            danh gia
          `),
          tl: termDoc(`
            suriin
            kumusta ang progreso
            tingnan ang layunin
            kamusta
            report
          `),
        },
      },
    },
    affirmative: {
      strong: {
        base: termDoc(`
          yes
          yeah
          yep
          yup
          ok
          okay
          sure
          confirm
          confirmed
          go ahead
          do it
          please do
          sounds good
          correct
          exactly
          perfect
          that works
          looks good
          go for it
          lgtm
          absolutely
          affirmative
          approved
          lets go
          let's go
          save it
          create it
        `),
        locales: {
          "zh-CN": termDoc(`
            是的
            好的
            确认
            可以
            没问题
            行
            对
            好
            确定
            同意
            当然
            就这样
            保存
            创建
          `),
          ko: termDoc(`
            네
            예
            좋아
            좋아요
            확인
            맞아
            괜찮아
            알겠어
            동의
            물론
            그래
            응
            저장
            만들어
          `),
          es: termDoc(`
            sí
            si
            claro
            vale
            bien
            confirmar
            de acuerdo
            perfecto
            adelante
            correcto
            exacto
            hazlo
            por favor
            listo
            guardar
            crear
          `),
          pt: termDoc(`
            sim
            claro
            ok
            beleza
            confirmar
            de acordo
            perfeito
            pode
            correto
            exato
            vai em frente
            com certeza
            salvar
            criar
          `),
          vi: termDoc(`
            vâng
            rồi
            được
            đồng ý
            đúng rồi
            ok
            chắc chắn
            xác nhận
            tốt
            hay
            đúng
            lưu
            tạo
          `),
          tl: termDoc(`
            oo
            sige
            tama
            sigurado
            ok
            ayos na
            kumpirmahin
            sabi mo
            ayan
            i-save
            gawin
          `),
        },
      },
    },
    negative: {
      strong: {
        base: termDoc(`
          no
          nope
          nah
          don't
          do not
          wait
          hold on
          cancel
          nevermind
          never mind
          forget it
          skip it
          stop
          not now
          not yet
        `),
        locales: {
          "zh-CN": termDoc(`
            不
            不要
            不是
            取消
            等一下
            算了
            别
            停
            不用
            暂时不
          `),
          ko: termDoc(`
            아니요
            아니
            안돼
            취소
            잠깐
            됐어
            하지마
            멈춰
            아직
            나중에
          `),
          es: termDoc(`
            no
            nada
            cancelar
            espera
            olvídalo
            olvidalo
            para
            detente
            todavía no
            aún no
            aun no
          `),
          pt: termDoc(`
            não
            nao
            nada
            cancelar
            espera
            esqueça
            esqueca
            pare
            ainda não
            ainda nao
          `),
          vi: termDoc(`
            không
            đừng
            hủy
            chờ
            thôi
            dừng
            chưa
            bỏ đi
          `),
          tl: termDoc(`
            hindi
            huwag
            kanselahin
            teka
            kalimutan mo na
            hinto
            wag
          `),
        },
      },
    },
    draft_edit: {
      strong: {
        base: termDoc(`
          how about
          what about
          instead
          actually
          make it
          change it
          edit it
          update it
          rename it
          switch it
          swap it
          rather
          keep it
          but change
          but make
        `),
        locales: {
          "zh-CN": termDoc(`
            改成
            换成
            改为
            换个
            怎么样
            还是
            改一下
            更新
            其实
            但是改
          `),
          ko: termDoc(`
            바꿔
            변경
            대신
            어떨까
            고쳐
            수정
            업데이트
            사실
            그런데
          `),
          es: termDoc(`
            cambiarlo
            mejor
            qué tal
            que tal
            en vez de
            editar
            actualizar
            renombrar
            en realidad
            pero cambia
          `),
          pt: termDoc(`
            mudar
            melhor
            que tal
            em vez de
            editar
            atualizar
            renomear
            na verdade
            mas muda
          `),
          vi: termDoc(`
            đổi thành
            thay đổi
            sửa
            cập nhật
            thế nào
            thực ra
            nhưng đổi
          `),
          tl: termDoc(`
            palitan
            baguhin
            imbes
            i-edit
            i-update
            sa halip
            pero palitan
          `),
        },
      },
    },
    temporal_next: {
      strong: {
        base: termDoc(`
          next
          upcoming
          soon
          about to
          coming up
          after this
        `),
        locales: {
          "zh-CN": termDoc(`
            下一个
            即将
            马上
            接下来
            快到了
          `),
          ko: termDoc(`
            다음
            곧
            다가오는
            이제
            곧 있을
          `),
          es: termDoc(`
            próximo
            proximo
            siguiente
            pronto
            a punto de
          `),
          pt: termDoc(`
            próximo
            proximo
            seguinte
            logo
            em breve
          `),
          vi: termDoc(`
            tiếp theo
            sắp tới
            sớm
            sắp
          `),
          tl: termDoc(`
            susunod
            malapit na
            mamaya
          `),
        },
      },
    },
    temporal_followup: {
      strong: {
        base: termDoc(`
          yesterday
          today
          tomorrow
          tonight
          later
          earlier
          this week
          next week
          the week after
          week after next
          this weekend
          next weekend
          weekend
          this month
          next month
          this year
          next year
          last year
          monday
          tuesday
          wednesday
          thursday
          friday
          saturday
          sunday
          find it
          look it up
          check again
          try to find
          try again
          retry
          again
        `),
        locales: {
          "zh-CN": termDoc(`
            昨天
            今天
            明天
            今晚
            稍后
            更早
            这周
            下周
            这个月
            下个月
            今年
            明年
            去年
            周一
            周二
            周三
            周四
            周五
            周六
            周日
            星期一
            星期二
            星期三
            星期四
            星期五
            星期六
            星期天
            再试
            查找
            再查
            再看看
          `),
          ko: termDoc(`
            어제
            오늘
            내일
            오늘밤
            나중에
            이번주
            다음주
            이번달
            다음달
            올해
            내년
            작년
            월요일
            화요일
            수요일
            목요일
            금요일
            토요일
            일요일
            다시
            찾아
            다시 시도
            다시 확인
          `),
          es: termDoc(`
            ayer
            hoy
            mañana
            esta noche
            luego
            más tarde
            mas tarde
            esta semana
            próxima semana
            proxima semana
            este mes
            próximo mes
            proximo mes
            este año
            este ano
            lunes
            martes
            miércoles
            miercoles
            jueves
            viernes
            sábado
            sabado
            domingo
            reintentar
            buscar
            otra vez
            de nuevo
          `),
          pt: termDoc(`
            ontem
            hoje
            amanhã
            amanha
            esta noite
            mais tarde
            esta semana
            próxima semana
            proxima semana
            este mês
            este mes
            próximo mês
            proximo mes
            este ano
            segunda
            terça
            terca
            quarta
            quinta
            sexta
            sábado
            sabado
            domingo
            tentar novamente
            procurar
            de novo
            outra vez
          `),
          vi: termDoc(`
            hôm qua
            hôm nay
            ngày mai
            tối nay
            sau
            sớm hơn
            tuần này
            tuần sau
            tháng này
            tháng sau
            năm nay
            năm sau
            năm ngoái
            thứ hai
            thứ ba
            thứ tư
            thứ năm
            thứ sáu
            thứ bảy
            chủ nhật
            thử lại
            tìm
            lại
          `),
          tl: termDoc(`
            kahapon
            ngayon
            bukas
            mamaya
            mamayang gabi
            ngayong linggo
            susunod na linggo
            ngayong buwan
            susunod na buwan
            ngayong taon
            lunes
            martes
            miyerkules
            huwebes
            biyernes
            sabado
            linggo
            subukan muli
            hanapin
            ulit
            muli
          `),
        },
      },
    },
  },
  provider: {
    recentConversations: {
      relevance: {
        base: termDoc(`
          recent
          conversation
          said
          told
          mentioned
          earlier
          before
          chat
          message
        `),
        locales: {
          "zh-CN": termDoc(`
            最近
            对话
            说过
            提到
            之前
            聊天
            消息
          `),
          ko: termDoc(`
            최근
            대화
            말했
            언급
            이전
            채팅
            메시지
          `),
          es: termDoc(`
            reciente
            conversación
            conversacion
            dijo
            mencionó
            menciono
            antes
            chat
            mensaje
          `),
          pt: termDoc(`
            recente
            conversa
            disse
            mencionou
            antes
            chat
            mensagem
          `),
          vi: termDoc(`
            gần đây
            gan day
            cuộc trò chuyện
            nói
            nhắc
            trước đó
            chat
            tin nhắn
          `),
          tl: termDoc(`
            recent
            usapan
            sinabi
            nabanggit
            dati
            chat
            mensahe
          `),
        },
      },
    },
    relevantConversations: {
      relevance: {
        base: termDoc(`
          search
          find
          remember
          who said
          conversation about
          discussed
          talked about
          mentioned
        `),
        locales: {
          "zh-CN": termDoc(`
            搜索
            查找
            记得
            谁说过
            提到
            聊过
          `),
          ko: termDoc(`
            검색
            찾기
            기억
            누가 말했어
            언급
            이야기했던
          `),
          es: termDoc(`
            buscar
            encontrar
            recordar
            quién dijo
            quien dijo
            hablaron de
            mencionó
            menciono
          `),
          pt: termDoc(`
            buscar
            encontrar
            lembrar
            quem disse
            falaram sobre
            mencionou
          `),
          vi: termDoc(`
            tìm
            nhớ
            ai đã nói
            ai da noi
            nhắc đến
            đã bàn về
            da ban ve
          `),
          tl: termDoc(`
            hanap
            tandaan
            sino ang nagsabi
            pinag-usapan
            nabanggit
          `),
        },
      },
    },
    rolodex: {
      relevance: {
        base: termDoc(`
          who
          contact
          reach
          rolodex
          know
          relationship
          person
          people
          friend
          user
        `),
        locales: {
          "zh-CN": termDoc(`
            谁
            联系人
            联络
            关系
            人
            朋友
            用户
          `),
          ko: termDoc(`
            누구
            연락처
            연락
            관계
            사람
            친구
            사용자
          `),
          es: termDoc(`
            quién
            quien
            contacto
            contactar
            relación
            relacion
            persona
            gente
            amigo
            usuario
          `),
          pt: termDoc(`
            quem
            contato
            contatar
            relação
            relacao
            pessoa
            pessoas
            amigo
            usuário
            usuario
          `),
          vi: termDoc(`
            ai
            liên hệ
            lien he
            mối quan hệ
            moi quan he
            người
            bạn bè
            ban be
            người dùng
            nguoi dung
          `),
          tl: termDoc(`
            sino
            contact
            kontak
            relasyon
            tao
            mga tao
            kaibigan
            user
          `),
        },
      },
    },
    uiCatalog: {
      relevance: {
        base: termDoc(`
          plugin
          plugins
          install
          setup
          set up
          configure
          config
          enable
          disable
          activate
          connect
          integration
          help me
          how do i
          how to
          show me
          dashboard
          form
          table
          chart
          metrics
          ui
          interface
          polymarket
          discord
          openai
          anthropic
          telegram
          twitch
          youtube
          twitter
          api key
          credentials
          secret
        `),
        locales: {
          "zh-CN": termDoc(`
            插件
            安装
            设置
            配置
            启用
            禁用
            激活
            连接
            集成
            帮我
            怎么
            给我看
            仪表盘
            表单
            表格
            图表
            指标
            界面
            api key
            凭证
            密钥
          `),
          ko: termDoc(`
            플러그인
            설치
            설정
            구성
            활성화
            비활성화
            연결
            통합
            도와줘
            어떻게
            보여줘
            대시보드
            폼
            테이블
            차트
            지표
            인터페이스
            api key
            자격 증명
            비밀
          `),
          es: termDoc(`
            plugin
            plugins
            instalar
            configuración
            configuracion
            configurar
            activar
            desactivar
            conectar
            integración
            integracion
            ayúdame
            ayudame
            cómo
            como
            muéstrame
            muestrame
            panel
            formulario
            tabla
            gráfico
            grafico
            métricas
            metricas
            interfaz
            api key
            credenciales
            secreto
          `),
          pt: termDoc(`
            plugin
            plugins
            instalar
            configuração
            configuracao
            configurar
            ativar
            desativar
            conectar
            integração
            integracao
            me ajuda
            como faço
            mostrar
            painel
            formulário
            formulario
            tabela
            gráfico
            grafico
            métricas
            metricas
            interface
            api key
            credenciais
            segredo
          `),
          vi: termDoc(`
            plugin
            cài đặt
            cai dat
            thiết lập
            thiet lap
            cấu hình
            cau hinh
            bật
            bat
            tắt
            tat
            kết nối
            ket noi
            tích hợp
            tich hop
            giúp tôi
            giup toi
            làm sao
            lam sao
            cho tôi xem
            dashboard
            biểu mẫu
            bieu mau
            bảng
            bang
            biểu đồ
            bieu do
            chỉ số
            chi so
            giao diện
            giao dien
            api key
            thông tin xác thực
            thong tin xac thuc
            bí mật
            bi mat
          `),
          tl: termDoc(`
            plugin
            plugins
            i-install
            i-setup
            i-configure
            config
            paganahin
            patayin
            i-connect
            integration
            tulungan mo ako
            paano
            ipakita mo
            dashboard
            form
            table
            chart
            metrics
            interface
            api key
            credentials
            secret
          `),
        },
      },
    },
  },
  action: {
    restart: {
      request: {
        base: termDoc(`
          restart
          reboot
          reload
          refresh
          respawn
        `),
        locales: {
          "zh-CN": termDoc(`
            重启
            重开
            重新加载
            刷新
          `),
          ko: termDoc(`
            재시작
            다시 시작
            재부팅
            다시 불러와
            새로고침
          `),
          es: termDoc(`
            reinicia
            reiniciar
            reinicio
            recarga
            recargar
            refresca
            refrescar
          `),
          pt: termDoc(`
            reinicia
            reiniciar
            reinício
            reinicio
            recarrega
            recarregar
            atualiza
            atualizar
          `),
          vi: termDoc(`
            khởi động lại
            khoi dong lai
            tải lại
            tai lai
            làm mới
            lam moi
          `),
          tl: termDoc(`
            i-restart
            restart
            i-reboot
            i-reload
            i-refresh
          `),
        },
      },
    },
    setUserName: {
      recentContext: {
        base: termDoc(`
          name
          my name is
          my name
          i'm
          i am
          call me
          call me by
          change my name
          rename me
        `),
        locales: {
          "zh-CN": termDoc(`
            名字
            我的名字
            我叫
            我是
            叫我
            称呼我
            改名字
          `),
          ko: termDoc(`
            이름
            내 이름
            제 이름은
            나는
            불러줘
            라고 불러
            이름 바꿔
          `),
          es: termDoc(`
            nombre
            mi nombre
            mi nombre es
            me llamo
            llámame
            llamame
            cambia mi nombre
          `),
          pt: termDoc(`
            nome
            meu nome
            meu nome é
            meu nome e
            me chamo
            me chama de
            chame-me
            muda meu nome
          `),
          vi: termDoc(`
            tên
            ten
            tên tôi
            ten toi
            tôi là
            toi la
            gọi tôi là
            goi toi la
            đổi tên tôi
            doi ten toi
          `),
          tl: termDoc(`
            pangalan
            ang pangalan ko
            ako si
            tawagin mo akong
            palitan ang pangalan ko
          `),
        },
      },
    },
    appControl: {
      launchVerb: {
        base: termDoc(`
          launch
          open
          start
          run
          show
        `),
        locales: {
          "zh-CN": termDoc(`
            启动
            打开
            运行
            开启
            显示
          `),
          ko: termDoc(`
            실행
            열어
            시작
            켜
            보여줘
          `),
          es: termDoc(`
            abre
            abrir
            inicia
            iniciar
            ejecuta
            mostrar
          `),
          pt: termDoc(`
            abre
            abrir
            inicia
            iniciar
            executa
            mostrar
          `),
          vi: termDoc(`
            mở
            mo
            khởi chạy
            khoi chay
            chạy
            chay
            bắt đầu
            bat dau
          `),
          tl: termDoc(`
            buksan
            simulan
            patakbuhin
            ipakita
          `),
        },
      },
      stopVerb: {
        base: termDoc(`
          stop
          close
          shut down
          kill
          quit
          exit
        `),
        locales: {
          "zh-CN": termDoc(`
            停止
            关闭
            关掉
            退出
          `),
          ko: termDoc(`
            중지
            멈춰
            종료
            닫아
            끄기
          `),
          es: termDoc(`
            detén
            detener
            cierra
            cerrar
            apaga
            salir
          `),
          pt: termDoc(`
            parar
            pare
            fechar
            fecha
            desliga
            sair
          `),
          vi: termDoc(`
            dừng
            dung
            tắt
            tat
            đóng
            dong
            thoát
            thoat
          `),
          tl: termDoc(`
            ihinto
            itigil
            isara
            patayin
            lumabas
          `),
        },
      },
      genericTarget: {
        base: termDoc(`
          app
          application
        `),
        locales: {
          "zh-CN": termDoc(`
            应用
            应用程序
            程序
          `),
          ko: termDoc(`
            앱
            애플리케이션
          `),
          es: termDoc(`
            app
            aplicación
            aplicacion
            programa
          `),
          pt: termDoc(`
            app
            aplicativo
            aplicação
            aplicacao
            programa
          `),
          vi: termDoc(`
            ứng dụng
            ung dung
          `),
          tl: termDoc(`
            app
            aplikasyon
            programa
          `),
        },
      },
      knownApp: {
        base: termDoc(`
          shopify
          vincent
          companion
          hyperscape
          babylon
        `),
        locales: {
          "zh-CN": termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
          ko: termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
          es: termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
          pt: termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
          vi: termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
          tl: termDoc(`
            shopify
            vincent
            companion
            hyperscape
            babylon
          `),
        },
      },
    },
    terminal: {
      commandVerb: {
        base: termDoc(`
          run
          execute
          start
          do
        `),
        locales: {
          "zh-CN": termDoc(`
            运行
            执行
            开始
          `),
          ko: termDoc(`
            실행
            돌려
            시작
            해줘
          `),
          es: termDoc(`
            ejecuta
            ejecutar
            corre
            correr
            inicia
          `),
          pt: termDoc(`
            executa
            executar
            roda
            rodar
            inicia
          `),
          vi: termDoc(`
            chạy
            chay
            thực hiện
            thuc hien
            bắt đầu
            bat dau
          `),
          tl: termDoc(`
            patakbuhin
            isagawa
            simulan
            gawin
          `),
        },
      },
      commandFiller: {
        base: termDoc(`
          command
          shell command
          terminal command
        `),
        locales: {
          "zh-CN": termDoc(`
            命令
            终端命令
            shell 命令
          `),
          ko: termDoc(`
            명령
            명령어
            터미널 명령
          `),
          es: termDoc(`
            comando
            comando de terminal
          `),
          pt: termDoc(`
            comando
            comando do terminal
          `),
          vi: termDoc(`
            lệnh
            lenh
            lệnh terminal
            lenh terminal
          `),
          tl: termDoc(`
            utos
            command
            utos sa terminal
          `),
        },
      },
      utility: {
        base: termDoc(`
          price
          worth
          cost
          balance
          status
          check
          curl
          fetch
          tail
          head
          log
        `),
        locales: {
          "zh-CN": termDoc(`
            价格
            余额
            状态
            检查
            日志
          `),
          ko: termDoc(`
            가격
            잔액
            상태
            확인
            로그
          `),
          es: termDoc(`
            precio
            costo
            balance
            saldo
            estado
            revisar
            log
          `),
          pt: termDoc(`
            preço
            preco
            custo
            saldo
            estado
            verificar
            log
          `),
          vi: termDoc(`
            giá
            gia
            số dư
            so du
            trạng thái
            trang thai
            kiểm tra
            kiem tra
            log
          `),
          tl: termDoc(`
            presyo
            balanse
            status
            check
            log
          `),
        },
      },
      cryptoBitcoin: {
        base: termDoc(`
          bitcoin
          btc
        `),
        locales: {
          "zh-CN": termDoc(`
            比特币
          `),
          ko: termDoc(`
            비트코인
          `),
          es: termDoc(`
            bitcóin
            bitcoín
            bitcoin
          `),
          pt: termDoc(`
            bitcóin
            bitcoin
          `),
          vi: termDoc(`
            đồng bitcoin
            dong bitcoin
            bitcoin
          `),
          tl: termDoc(`
            bitcoin
            barya ng bitcoin
          `),
        },
      },
      cryptoEthereum: {
        base: termDoc(`
          ethereum
          eth
        `),
        locales: {
          "zh-CN": termDoc(`
            以太坊
          `),
          ko: termDoc(`
            이더리움
          `),
          es: termDoc(`
            ethereum
            etéreo
            etereo
          `),
          pt: termDoc(`
            ethereum
            ether
          `),
          vi: termDoc(`
            ethereum
            đồng ethereum
            dong ethereum
          `),
          tl: termDoc(`
            ethereum
            ether
          `),
        },
      },
      cryptoSolana: {
        base: termDoc(`
          solana
          sol
        `),
        locales: {
          "zh-CN": termDoc(`
            索拉纳
          `),
          ko: termDoc(`
            솔라나
          `),
          es: termDoc(`
            solana
          `),
          pt: termDoc(`
            solana
          `),
          vi: termDoc(`
            solana
            đồng solana
            dong solana
          `),
          tl: termDoc(`
            solana
          `),
        },
      },
      disk: {
        base: termDoc(`
          disk
          space
          storage
          disk usage
        `),
        locales: {
          "zh-CN": termDoc(`
            磁盘
            空间
            存储
          `),
          ko: termDoc(`
            디스크
            저장공간
            저장소
          `),
          es: termDoc(`
            disco
            espacio
            almacenamiento
          `),
          pt: termDoc(`
            disco
            espaço
            espaco
            armazenamento
          `),
          vi: termDoc(`
            ổ đĩa
            o dia
            dung lượng
            dung luong
            lưu trữ
            luu tru
          `),
          tl: termDoc(`
            disk
            espasyo
            storage
          `),
        },
      },
      uptime: {
        base: termDoc(`
          uptime
          load
        `),
        locales: {
          "zh-CN": termDoc(`
            运行时间
            负载
          `),
          ko: termDoc(`
            업타임
            부하
          `),
          es: termDoc(`
            tiempo activo
            carga
          `),
          pt: termDoc(`
            uptime
            tempo ativo
            carga
          `),
          vi: termDoc(`
            thời gian hoạt động
            thoi gian hoat dong
            tải
            tai
          `),
          tl: termDoc(`
            uptime
            load
          `),
        },
      },
      memory: {
        base: termDoc(`
          memory
          ram
        `),
        locales: {
          "zh-CN": termDoc(`
            内存
          `),
          ko: termDoc(`
            메모리
            램
          `),
          es: termDoc(`
            memoria
            ram
          `),
          pt: termDoc(`
            memória
            memoria
            ram
          `),
          vi: termDoc(`
            bộ nhớ
            bo nho
            ram
          `),
          tl: termDoc(`
            memory
            ram
          `),
        },
      },
      process: {
        base: termDoc(`
          process
          processes
          top
          memory usage
        `),
        locales: {
          "zh-CN": termDoc(`
            进程
            进程列表
            内存占用
          `),
          ko: termDoc(`
            프로세스
            top
            메모리 사용
          `),
          es: termDoc(`
            proceso
            procesos
            top
            uso de memoria
          `),
          pt: termDoc(`
            processo
            processos
            top
            uso de memória
            uso de memoria
          `),
          vi: termDoc(`
            tiến trình
            tien trinh
            top
            dùng bộ nhớ
            dung bo nho
          `),
          tl: termDoc(`
            process
            mga proseso
            top
            gamit ng memory
          `),
        },
      },
    },
    logLevel: {
      command: {
        base: termDoc(`
          /loglevel
          log level
          logging level
        `),
        locales: {
          "zh-CN": termDoc(`
            日志级别
            日志等级
          `),
          ko: termDoc(`
            로그 레벨
            로깅 레벨
          `),
          es: termDoc(`
            nivel de log
            nivel de registro
          `),
          pt: termDoc(`
            nível de log
            nivel de log
            nível de registro
            nivel de registro
          `),
          vi: termDoc(`
            mức log
            muc log
            mức ghi log
            muc ghi log
          `),
          tl: termDoc(`
            antas ng log
            antas ng pag-log
          `),
        },
      },
      setVerb: {
        base: termDoc(`
          set
          change
          switch
        `),
        locales: {
          "zh-CN": termDoc(`
            设置
            调成
            改成
            切换
          `),
          ko: termDoc(`
            설정
            바꿔
            변경
            전환
          `),
          es: termDoc(`
            pon
            poner
            cambia
            cambiar
            ajusta
          `),
          pt: termDoc(`
            define
            definir
            muda
            mudar
            ajusta
          `),
          vi: termDoc(`
            đặt
            dat
            đổi
            doi
            chuyển
            chuyen
          `),
          tl: termDoc(`
            itakda
            palitan
            ilipat
          `),
        },
      },
      domain: {
        base: termDoc(`
          log
          logging
          verbosity
        `),
        locales: {
          "zh-CN": termDoc(`
            日志
            详细程度
          `),
          ko: termDoc(`
            로그
            로깅
            상세도
          `),
          es: termDoc(`
            log
            registro
            verbosidad
          `),
          pt: termDoc(`
            log
            registro
            verbosidade
          `),
          vi: termDoc(`
            log
            ghi log
            độ chi tiết
            do chi tiet
          `),
          tl: termDoc(`
            log
            pag-log
            verbosity
          `),
        },
      },
      level: {
        trace: {
          base: termDoc(`
            trace
          `),
          locales: {
            "zh-CN": termDoc(`
              跟踪
            `),
            ko: termDoc(`
              추적
            `),
            es: termDoc(`
              rastreo
            `),
            pt: termDoc(`
              rastreamento
            `),
            vi: termDoc(`
              theo dõi
              theo doi
            `),
            tl: termDoc(`
              bakas
              trace
            `),
          },
        },
        debug: {
          base: termDoc(`
            debug
          `),
          locales: {
            "zh-CN": termDoc(`
              调试
            `),
            ko: termDoc(`
              디버그
            `),
            es: termDoc(`
              depuración
              depuracion
            `),
            pt: termDoc(`
              depuração
              depuracao
            `),
            vi: termDoc(`
              gỡ lỗi
              go loi
            `),
            tl: termDoc(`
              debug
              pag-debug
            `),
          },
        },
        info: {
          base: termDoc(`
            info
            information
          `),
          locales: {
            "zh-CN": termDoc(`
              信息
            `),
            ko: termDoc(`
              정보
            `),
            es: termDoc(`
              información
              informacion
            `),
            pt: termDoc(`
              informação
              informacao
            `),
            vi: termDoc(`
              thông tin
              thong tin
            `),
            tl: termDoc(`
              impormasyon
            `),
          },
        },
        warn: {
          base: termDoc(`
            warn
            warning
          `),
          locales: {
            "zh-CN": termDoc(`
              警告
            `),
            ko: termDoc(`
              경고
            `),
            es: termDoc(`
              advertencia
            `),
            pt: termDoc(`
              aviso
              advertência
              advertencia
            `),
            vi: termDoc(`
              cảnh báo
              canh bao
            `),
            tl: termDoc(`
              babala
            `),
          },
        },
        error: {
          base: termDoc(`
            error
            errors
          `),
          locales: {
            "zh-CN": termDoc(`
              错误
            `),
            ko: termDoc(`
              오류
            `),
            es: termDoc(`
              error
              errores
            `),
            pt: termDoc(`
              erro
            `),
            vi: termDoc(`
              lỗi
              loi
            `),
            tl: termDoc(`
              error
              mga error
            `),
          },
        },
      },
    },
    updateRole: {
      intent: {
        base: termDoc(`
          role
          assign role
          set role
          change role
          update role
          boss
          manager
          supervisor
          superior
          lead
          coworker
          co-worker
          teammate
          colleague
          peer
          friend
          partner
          admin
          owner
          guest
          member
          user
          mod
          moderator
          promote
          demote
          revoke
          remove role
        `),
        locales: {
          "zh-CN": termDoc(`
            角色
            分配角色
            设置角色
            修改角色
            老板
            经理
            主管
            上级
            负责人
            同事
            队友
            伙伴
            管理员
            所有者
            主人
            访客
            成员
            用户
            版主
            提升
            升级
            降级
            撤销
            移除角色
          `),
          ko: termDoc(`
            역할
            역할 설정
            역할 변경
            상사
            매니저
            관리자
            감독자
            리더
            동료
            팀원
            친구
            파트너
            오너
            소유자
            게스트
            멤버
            사용자
            모더레이터
            승급
            강등
            철회
          `),
          es: termDoc(`
            rol
            asigna el rol
            cambiar el rol
            jefe
            jefa
            gerente
            supervisor
            líder
            lider
            compañero
            companero
            colega
            amigo
            socio
            administrador
            dueño
            dueno
            propietario
            invitado
            miembro
            usuario
            moderador
            asciende
            promociona
            degrada
            revoca
            quitar el rol
          `),
          pt: termDoc(`
            papel
            função
            funcao
            cargo
            atribuir papel
            mudar papel
            chefe
            gerente
            supervisor
            líder
            lider
            colega
            amigo
            parceiro
            administrador
            dono
            proprietário
            proprietario
            convidado
            membro
            usuário
            usuario
            moderador
            promover
            rebaixar
            revogar
            remover papel
          `),
          vi: termDoc(`
            vai trò
            vai tro
            gán vai trò
            gan vai tro
            đổi vai trò
            doi vai tro
            sếp
            sep
            quản lý
            quan ly
            giám sát
            giam sat
            trưởng nhóm
            truong nhom
            đồng nghiệp
            dong nghiep
            bạn bè
            ban be
            đối tác
            doi tac
            quản trị viên
            quan tri vien
            chủ sở hữu
            chu so huu
            khách
            thành viên
            thanh vien
            người dùng
            nguoi dung
            điều hành viên
            dieu hanh vien
            thăng cấp
            thang cap
            hạ cấp
            ha cap
            thu hồi
            thu hoi
          `),
          tl: termDoc(`
            role
            tungkulin
            itakda ang role
            baguhin ang role
            boss
            manager
            supervisor
            lead
            katrabaho
            kasamahan
            kaibigan
            partner
            admin
            may-ari
            guest
            miyembro
            user
            mod
            moderador
            i-promote
            i-demote
            bawiin
            alisin ang role
          `),
        },
      },
    },
    triggerCreate: {
      request: {
        base: termDoc(`
          schedule
          scheduled
          trigger
          heartbeat
          cron
          recurring
          recur
          repeat
          repeating
          reminder
          remind
          automate
          automation
          automatic
          periodic
          interval
          follow up
          check in
          every day
          every week
          every month
          every hour
          daily
          weekly
          monthly
          hourly
          alarm
          wake me
        `),
        locales: {
          "zh-CN": termDoc(`
            安排
            定时
            触发器
            心跳
            cron
            循环
            重复
            提醒
            提醒我
            自动化
            自动
            定期
            间隔
            跟进
            检查一下
            每天
            每周
            每月
            每小时
            闹钟
            叫醒我
          `),
          ko: termDoc(`
            예약
            예약해
            트리거
            하트비트
            크론
            반복
            반복적으로
            알림
            리마인더
            자동화
            자동
            주기적
            간격
            후속 확인
            매일
            매주
            매달
            매시간
            알람
            깨워줘
          `),
          es: termDoc(`
            programa
            programar
            recordatorio
            recordar
            recurrente
            repetir
            automatiza
            automatizar
            automático
            automatico
            periódico
            periodico
            intervalo
            seguimiento
            cada día
            cada dia
            cada semana
            cada mes
            cada hora
            diario
            semanal
            mensual
            alarma
            despiértame
            despiertame
          `),
          pt: termDoc(`
            programa
            programar
            lembrete
            lembrar
            recorrente
            repetir
            automatiza
            automatizar
            automático
            automatico
            periódico
            periodico
            intervalo
            acompanhamento
            cada dia
            cada semana
            cada mês
            cada mes
            cada hora
            diário
            diario
            semanal
            mensal
            alarme
            me acorde
          `),
          vi: termDoc(`
            lên lịch
            len lich
            lời nhắc
            loi nhac
            nhắc tôi
            nhac toi
            lặp lại
            lap lai
            tự động
            tu dong
            tự động hóa
            tu dong hoa
            định kỳ
            dinh ky
            khoảng cách
            khoang cach
            theo dõi
            theo doi
            mỗi ngày
            moi ngay
            mỗi tuần
            moi tuan
            mỗi tháng
            moi thang
            mỗi giờ
            moi gio
            báo thức
            bao thuc
            đánh thức tôi
            danh thuc toi
          `),
          tl: termDoc(`
            iskedyul
            paalala
            ipaalala
            paulit-ulit
            ulitin
            awtomatiko
            awtomasyon
            pana-panahon
            pagitan
            follow up
            kada araw
            kada linggo
            kada buwan
            kada oras
            alarm
            gisingin mo ako
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
    locale?: unknown;
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

  const locale = normalizeCharacterLanguage(options?.locale);
  return splitKeywordDoc(`${doc.base ?? ""}\n${doc.locales?.[locale] ?? ""}`);
}

export function getValidationKeywordLocaleTerms(
  key: string,
  locale: unknown,
): string[] {
  const doc = lookupValidationKeywordDoc(key);
  const normalizedLocale = normalizeCharacterLanguage(locale);
  return splitKeywordDoc(doc.locales?.[normalizedLocale] ?? "");
}
