/**
 * Storybook states for the Files page using deterministic stored-file fixtures
 * and stubbed file client methods.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { client, type StoredFile } from "../../api";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { FilesView } from "./FilesView";

/**
 * FilesView stories.
 *
 * Determinism-safe: the data is stubbed by overriding `client.listFiles` (no
 * network in the story) and every `createdAt` is a fixed epoch timestamp —
 * never `Date.now()` / random — so story-gate screenshots stay byte-stable.
 */

const meta = {
  title: "Pages/FilesView",
  component: FilesView,
  tags: ["autodocs"],
  decorators: [
    withMockApp,
    (Story) => (
      <div className="flex h-[44rem] flex-col bg-bg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof FilesView>;

export default meta;

type Story = StoryObj<typeof meta>;

// Fixed timestamps (epoch ms) — deterministic across renders.
const FIXED_NOW = 1_700_000_000_000;

const FIXTURE_FILES: StoredFile[] = [
  {
    url: "/media/sunset.png",
    hash: "hash-image",
    fileName: "sunset.png",
    mimeType: "image/png",
    size: 824_300,
    createdAt: FIXED_NOW,
  },
  {
    url: "/media/quarterly-report.pdf",
    hash: "hash-pdf",
    fileName: "quarterly-report.pdf",
    mimeType: "application/pdf",
    size: 2_340_000,
    createdAt: FIXED_NOW - 86_400_000,
  },
  {
    url: "/media/voice-note.mp3",
    hash: "hash-audio",
    fileName: "voice-note.mp3",
    mimeType: "audio/mpeg",
    size: 512_000,
    createdAt: FIXED_NOW - 2 * 86_400_000,
  },
  {
    url: "/media/demo-clip.mp4",
    hash: "hash-video",
    fileName: "demo-clip.mp4",
    mimeType: "video/mp4",
    size: 9_800_000,
    createdAt: FIXED_NOW - 3 * 86_400_000,
  },
];

/**
 * Override the api singleton's file methods so the story renders populated
 * (or empty) data without a backend. The `client` is a plain singleton object,
 * so assigning its methods is safe and scoped to the story render.
 */
function withStubbedFiles(
  files: StoredFile[],
): NonNullable<Story["decorators"]> {
  return [
    (Story) => {
      const stubbed = client as {
        listFiles: () => Promise<{ files: StoredFile[] }>;
        deleteFile: () => Promise<{ deleted: boolean }>;
      };
      stubbed.listFiles = () => Promise.resolve({ files });
      stubbed.deleteFile = () => Promise.resolve({ deleted: true });
      return <Story />;
    },
  ];
}

/** Populated grid across all facet kinds. */
export const Populated: Story = {
  decorators: withStubbedFiles(FIXTURE_FILES),
};

/** Empty state — no files stored yet. */
export const Empty: Story = {
  decorators: withStubbedFiles([]),
};
