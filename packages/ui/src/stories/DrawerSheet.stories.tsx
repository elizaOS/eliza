import type { Meta, StoryObj } from "@storybook/react";

import {
  Button,
  DrawerSheet,
  DrawerSheetContent,
  DrawerSheetDescription,
  DrawerSheetHeader,
  DrawerSheetTitle,
} from "../index";

const meta = {
  title: "UI/DrawerSheet",
  component: DrawerSheetContent,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof DrawerSheetContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="min-h-screen bg-bg/60 p-6">
      <DrawerSheet open>
        <DrawerSheetContent className="max-w-[40rem]">
          <div className="space-y-5 p-5">
            <DrawerSheetHeader>
              <DrawerSheetTitle>Quick Actions</DrawerSheetTitle>
              <DrawerSheetDescription>
                Review the most common workspace actions on smaller screens.
              </DrawerSheetDescription>
            </DrawerSheetHeader>

            <div className="grid gap-3">
              <div className="rounded-2xl border border-border/40 bg-bg/45 px-4 py-3 text-sm">
                Open the current browser tab in the external browser
              </div>
              <div className="rounded-2xl border border-border/40 bg-bg/45 px-4 py-3 text-sm">
                Approve the pending wallet send
              </div>
              <div className="rounded-2xl border border-border/40 bg-bg/45 px-4 py-3 text-sm">
                Reset unsaved character editor changes
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline">Dismiss</Button>
              <Button>Run action</Button>
            </div>
          </div>
        </DrawerSheetContent>
      </DrawerSheet>
    </div>
  ),
};
