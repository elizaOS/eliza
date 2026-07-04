/**
 * Storybook stories for the cloud-ui brand/provider icons.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  AppleMessagesIcon,
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "./icons";

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => JSX.Element;

interface IconShowcaseProps {
  size: number;
  color: string;
  background: string;
}

const ICONS: { name: string; Component: IconComponent }[] = [
  { name: "Discord", Component: DiscordIcon },
  { name: "Telegram", Component: TelegramIcon },
  { name: "WhatsApp", Component: WhatsAppIcon },
  { name: "AppleMessages", Component: AppleMessagesIcon },
  { name: "iMessage", Component: IMessageIcon },
];

function IconGallery({ size, color, background }: IconShowcaseProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
        gap: "16px",
        padding: "16px",
        background,
        borderRadius: 12,
      }}
    >
      {ICONS.map(({ name, Component }) => (
        <div
          key={name}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: 12,
            border: "1px solid rgba(127,127,127,0.2)",
            borderRadius: 8,
            color,
          }}
        >
          <Component width={size} height={size} />
          <span style={{ fontSize: 12, fontFamily: "system-ui, sans-serif" }}>
            {name}
          </span>
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: "CloudUI/Icons",
  component: IconGallery,
  tags: ["autodocs"],
  argTypes: {
    size: { control: { type: "range", min: 16, max: 96, step: 4 } },
    color: { control: "color" },
    background: { control: "color" },
  },
  args: {
    size: 40,
    color: "#111111",
    background: "#ffffff",
  },
} satisfies Meta<typeof IconGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};

export const Small: Story = {
  args: { size: 20 },
};

export const Large: Story = {
  args: { size: 72 },
};

export const OnDark: Story = {
  args: {
    color: "#ffffff",
    background: "#0b0b0c",
  },
};

export const AccentTinted: Story = {
  args: {
    color: "#f97316",
    background: "#fff7ed",
  },
};

export const Individual: StoryObj = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: 24,
        alignItems: "center",
        padding: 24,
        color: "#111",
      }}
    >
      <DiscordIcon width={32} height={32} />
      <TelegramIcon width={32} height={32} />
      <WhatsAppIcon width={32} height={32} />
      <AppleMessagesIcon width={32} height={32} />
      <IMessageIcon width={32} height={32} />
    </div>
  ),
};
