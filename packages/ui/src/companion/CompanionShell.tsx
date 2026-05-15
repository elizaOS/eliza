import type { ReactNode } from "react";
import { AvatarHost } from "../avatar-runtime";
import { BackgroundHost } from "../backgrounds";
import {
  CompactMessageStack,
  type CompanionMessage,
} from "./CompactMessageStack";
import { ComposerBar, type ComposerBarProps } from "./ComposerBar";

export interface CompanionShellProps extends ComposerBarProps {
  messages: readonly CompanionMessage[];
  avatarModuleId?: string;
  audioLevel?: () => number;
  ownerName?: string;
  className?: string;
  headerSlot?: ReactNode;
  footerSlot?: ReactNode;
}

export function CompanionShell(props: CompanionShellProps): JSX.Element {
  const {
    messages,
    avatarModuleId,
    audioLevel,
    ownerName,
    className,
    headerSlot,
    footerSlot,
    ...composerProps
  } = props;

  return (
    <div
      data-eliza-companion-shell=""
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#1d91e8",
        color: "#ffffff",
        fontFamily: "'Open Sans', Arial, sans-serif",
      }}
    >
      <BackgroundHost />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          flex: 1,
          padding: "30px 22px 22px",
        }}
      >
        {headerSlot}
        <div
          data-eliza-companion-avatar=""
          style={{
            position: "relative",
            flex: 1,
            display: "grid",
            placeItems: "center",
            minHeight: 220,
          }}
        >
          <AvatarHost
            moduleId={avatarModuleId}
            audioLevel={audioLevel}
            ownerName={ownerName}
          />
        </div>
        <CompactMessageStack messages={messages} />
        <ComposerBar {...composerProps} />
        {footerSlot}
      </div>
    </div>
  );
}
