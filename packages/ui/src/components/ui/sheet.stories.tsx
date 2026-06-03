import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

const meta = {
  title: "Primitives/Sheet",
  component: Sheet,
  tags: ["autodocs"],
  args: { open: true },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Sheet {...args}>
      <SheetTrigger asChild>
        <Button variant="outline">Open sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit profile</SheetTitle>
          <SheetDescription>
            Make changes to your profile here. Click save when you're done.
          </SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="ghost">Cancel</Button>
          </SheetClose>
          <Button>Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const LeftSide: Story = {
  render: (args) => (
    <Sheet {...args}>
      <SheetTrigger asChild>
        <Button variant="outline">Open navigation</Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Jump to a section of the app.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};

export const BottomSide: Story = {
  render: (args) => (
    <Sheet {...args}>
      <SheetTrigger asChild>
        <Button variant="outline">Open details</Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Session details</SheetTitle>
          <SheetDescription>
            A bottom-anchored panel for contextual actions.
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};

export const TopSide: Story = {
  render: (args) => (
    <Sheet {...args}>
      <SheetTrigger asChild>
        <Button variant="outline">Show banner</Button>
      </SheetTrigger>
      <SheetContent side="top">
        <SheetHeader>
          <SheetTitle>New release available</SheetTitle>
          <SheetDescription>
            Update now to get the latest features and fixes.
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};
