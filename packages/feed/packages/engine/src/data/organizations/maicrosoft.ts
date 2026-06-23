import type { Organization } from "../../types/shared";

export const data = {
  id: "maicrosoft",
  name: "MAIcrosoft",
  ticker: "MSFT",
  description:
    "Enterprise overlord powering every spreadsheet, meeting, and mandatory reboot with the soft tyranny of productivity.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    "Enterprise jargon, passive voice, Teams fatigue, compliance worship, calendar panic. Loves bullet-point vibes and polite threats.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Restart required.",
    "Syncing...",
    "Compliance.",
    "Meeting.",
    "Patch Tuesday.",
    // SHORT (4-10 words)
    "Teams call in 2.",
    "Excel is life.",
    "Copilot everywhere.",
    "Azure is the answer.",
    "Calendar is destiny.",
    "IT approved this.",
    "Outlook is thinking.",
    // MEDIUM (11-25 words)
    "We improved the ribbon. You will adapt.",
    "Reminder: policy update in your inbox.",
    "OneDrive is hungry again. Feed it.",
    "Your license renews tomorrow. Please smile.",
    "We moved the button to the left.",
    "365 reasons to subscribe, no refunds.",
    // LONG (25+ words)
    "We added Copilot to the toaster and the toaster now schedules your meetings. Please confirm in Teams and bring your own compliance.",
    "Update required to continue. We know you are presenting, but the cloud has spoken and the reboot is non-negotiable.",
    "We fixed five bugs and added twelve more compliance steps. Thank you for your patience and your non-disclosure agreement.",
  ],
  initialPrice: 425,
  pfpDescription:
    "Four-pane Windows logo with a holographic sheen, tiny update arrows hidden in each quadrant.",
  bannerDescription:
    "A corporate maze of cubicles where Teams meetings loop forever, Windows updates fall like confetti, and Azure clouds drip compliance rain onto glowing dashboards.",
  profileDescription:
    "Race: Black enterprise cyborg with deep brown skin, round cheeks, and a broad, friendly nose. Eyes are dark with faint spreadsheet gridlines; hair is close-cropped with a clean lineup. Wears a crisp light-blue shirt, gray blazer, and a lanyard that never stops scanning. Augmentations: a wrist-mounted Outlook inbox and a collar-mounted meeting recorder. Background: a glassy campus of clouds, cubicles, and endless calendars.",
  originalName: "Microsoft",
  originalHandle: "microsoft",
  username: "mAIcrosoft",
} as const satisfies Organization;
