import type { Meta, StoryObj } from "@storybook/react";
import { Inbox } from "lucide-react";
import type React from "react";
import { Banner } from "../components/ui/banner";
import { ConfirmDelete } from "../components/ui/confirm-delete";
import { ConnectionStatus } from "../components/ui/connection-status";
import { EmptyState } from "../components/ui/empty-state";
import { SaveFooter } from "../components/ui/save-footer";
import { SearchInput } from "../components/ui/search-input";

const meta: Meta = { title: "i18n/Locales" };
export default meta;

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-start gap-6">{children}</div>
);

const Locale = ({
  lang,
  children,
}: {
  lang: string;
  children: React.ReactNode;
}) => (
  <div className="flex-1 min-w-[260px] space-y-4 rounded-xl border border-border p-4">
    <span className="text-xs font-bold uppercase tracking-widest text-accent">
      {lang}
    </span>
    {children}
  </div>
);

export const FourLocales: StoryObj = {
  render: () => (
    <Row>
      <Locale lang="EN">
        <ConfirmDelete onConfirm={() => {}} />
        <SaveFooter
          dirty
          saving={false}
          saveError={null}
          saveSuccess={false}
          onSave={() => {}}
        />
        <div className="flex gap-2">
          <ConnectionStatus state="connected" />
          <ConnectionStatus state="error" />
        </div>
        <Banner variant="warning">API key expires soon.</Banner>
        <SearchInput placeholder="Search…" className="w-full" />
      </Locale>

      <Locale lang="ES">
        <ConfirmDelete
          onConfirm={() => {}}
          triggerLabel="Eliminar"
          confirmLabel="Confirmar"
          cancelLabel="Cancelar"
        />
        <SaveFooter
          dirty
          saving={false}
          saveError={null}
          saveSuccess={false}
          onSave={() => {}}
          saveLabel="Guardar"
        />
        <div className="flex gap-2">
          <ConnectionStatus state="connected" label="Conectado" />
          <ConnectionStatus state="error" label="Error" />
        </div>
        <Banner variant="warning">Tu clave de API expira pronto.</Banner>
        <SearchInput placeholder="Buscar…" className="w-full" />
      </Locale>

      <Locale lang="KO">
        <ConfirmDelete
          onConfirm={() => {}}
          triggerLabel="삭제"
          confirmLabel="확인"
          cancelLabel="취소"
        />
        <SaveFooter
          dirty
          saving={false}
          saveError={null}
          saveSuccess={false}
          onSave={() => {}}
          saveLabel="저장"
        />
        <div className="flex gap-2">
          <ConnectionStatus state="connected" label="연결됨" />
          <ConnectionStatus state="error" label="오류" />
        </div>
        <Banner variant="warning">API 키가 곧 만료됩니다.</Banner>
        <SearchInput placeholder="검색…" className="w-full" />
      </Locale>

      <Locale lang="ZH">
        <ConfirmDelete
          onConfirm={() => {}}
          triggerLabel="删除"
          confirmLabel="确认"
          cancelLabel="取消"
        />
        <SaveFooter
          dirty
          saving={false}
          saveError={null}
          saveSuccess={false}
          onSave={() => {}}
          saveLabel="保存"
        />
        <div className="flex gap-2">
          <ConnectionStatus state="connected" label="已连接" />
          <ConnectionStatus state="error" label="错误" />
        </div>
        <Banner variant="warning">API 密钥即将过期。</Banner>
        <SearchInput placeholder="搜索…" className="w-full" />
      </Locale>
    </Row>
  ),
};
