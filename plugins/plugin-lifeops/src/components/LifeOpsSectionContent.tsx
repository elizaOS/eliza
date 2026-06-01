import type { ReactNode } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { LifeOpsAssistantSection } from "./LifeOpsAssistantSection.js";
import { LifeOpsCalendarSection } from "./LifeOpsCalendarSection.js";
import { LifeOpsDocumentsSection } from "./LifeOpsDocumentsSection.js";
import {
  LIFEOPS_MAIL_CHANNELS,
  LIFEOPS_MESSAGE_CHANNELS,
  LifeOpsInboxSection,
} from "./LifeOpsInboxSection.js";
import { LifeOpsMoneySection } from "./LifeOpsMoneySection.js";
import { LifeOpsOverviewSection } from "./LifeOpsOverviewSection.js";
import { LifeOpsRemindersSection } from "./LifeOpsRemindersSection.js";

interface LifeOpsSectionContentProps {
  section: LifeOpsSection;
  navigate: (section: LifeOpsSection) => void;
  setupContent: ReactNode;
}

export function LifeOpsSectionContent({
  section,
  navigate,
  setupContent,
}: LifeOpsSectionContentProps): ReactNode {
  switch (section) {
    case "assistant":
      return <LifeOpsAssistantSection />;
    case "overview":
      return <LifeOpsOverviewSection onNavigate={navigate} />;
    case "sleep":
    case "screen-time":
      return <LifeOpsAssistantSection />;
    case "calendar":
      return <LifeOpsCalendarSection />;
    case "messages":
      return (
        <LifeOpsInboxSection
          channels={LIFEOPS_MESSAGE_CHANNELS}
          title="Messages"
          emptyLabel="No messages."
        />
      );
    case "mail":
      return (
        <LifeOpsInboxSection
          channels={LIFEOPS_MAIL_CHANNELS}
          title="Mail"
          emptyLabel="No mail."
        />
      );
    case "reminders":
      return <LifeOpsRemindersSection />;
    case "money":
      return <LifeOpsMoneySection />;
    case "documents":
      return <LifeOpsDocumentsSection />;
    case "setup":
      return setupContent;
  }
}
