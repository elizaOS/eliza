/**
 * Storybook stories for the cloud-ui drawer.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";

const meta = {
  title: "CloudUI/Drawer",
  component: Drawer,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const triggerButtonClass =
  "rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10";

const primaryButtonClass =
  "rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-orange-600";

const secondaryButtonClass =
  "rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/5";

export const BottomSheet: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger className={triggerButtonClass}>
        Open bottom drawer
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Confirm deployment</DrawerTitle>
          <DrawerDescription>
            This will roll out the new agent version to production.
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2 text-sm text-white/70">
          The current rollout will be replaced and all active sessions will be
          migrated to the new build.
        </div>
        <DrawerFooter>
          <button type="button" className={primaryButtonClass}>
            Deploy now
          </button>
          <DrawerClose className={secondaryButtonClass}>Cancel</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

export const RightSide: Story = {
  render: () => (
    <Drawer direction="right">
      <DrawerTrigger className={triggerButtonClass}>
        Open side panel
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Agent settings</DrawerTitle>
          <DrawerDescription>
            Configure runtime behavior for this assistant.
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-3 px-4 py-2 text-sm text-white/80">
          <label className="flex items-center justify-between gap-4">
            <span>Stream responses</span>
            <input type="checkbox" defaultChecked />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>Auto-summarize sessions</span>
            <input type="checkbox" />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>Verbose logging</span>
            <input type="checkbox" />
          </label>
        </div>
        <DrawerFooter>
          <button type="button" className={primaryButtonClass}>
            Save changes
          </button>
          <DrawerClose className={secondaryButtonClass}>Close</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

export const LeftSide: Story = {
  render: () => (
    <Drawer direction="left">
      <DrawerTrigger className={triggerButtonClass}>
        Open navigation
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Navigation</DrawerTitle>
          <DrawerDescription>Jump to a workspace section.</DrawerDescription>
        </DrawerHeader>
        <nav className="flex flex-col gap-1 px-2 py-2 text-sm text-white/85">
          {["Overview", "Agents", "Deployments", "Billing", "Settings"].map(
            (item) => (
              <button
                key={item}
                type="button"
                className="rounded-md px-3 py-2 text-left transition hover:bg-white/5"
              >
                {item}
              </button>
            ),
          )}
        </nav>
      </DrawerContent>
    </Drawer>
  ),
};

export const TopSheet: Story = {
  render: () => (
    <Drawer direction="top">
      <DrawerTrigger className={triggerButtonClass}>
        Open notifications
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Notifications</DrawerTitle>
          <DrawerDescription>3 new updates from your agents.</DrawerDescription>
        </DrawerHeader>
        <ul className="flex flex-col gap-2 px-4 pb-4 text-sm text-white/80">
          <li className="rounded-md border border-white/10 bg-white/5 p-3">
            Deployment <strong>web-agent</strong> completed successfully.
          </li>
          <li className="rounded-md border border-white/10 bg-white/5 p-3">
            Billing usage crossed 80% of monthly limit.
          </li>
          <li className="rounded-md border border-white/10 bg-white/5 p-3">
            New API token created.
          </li>
        </ul>
      </DrawerContent>
    </Drawer>
  ),
};
