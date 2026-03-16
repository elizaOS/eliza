import { ChatAvatar } from "../ChatAvatar";

/** PIP avatar overlay — small VRM in bottom-left corner of the main area. */
export function AvatarPip({ isSpeaking }: { isSpeaking: boolean }) {
  return (
    <div className="absolute bottom-3 left-3 z-10 w-[140px] h-[180px] xl:w-[180px] xl:h-[220px] rounded-lg overflow-hidden border border-border/50 bg-bg/60 backdrop-blur-sm shadow-lg pointer-events-none">
      <ChatAvatar isSpeaking={isSpeaking} />
    </div>
  );
}
