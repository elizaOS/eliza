import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import {
  DrawerSheet,
  DrawerSheetClose,
  DrawerSheetContent,
  DrawerSheetDescription,
  DrawerSheetHeader,
  DrawerSheetTitle,
  DrawerSheetTrigger,
} from "./drawer-sheet";

const meta = {
  title: "Primitives/DrawerSheet",
  component: DrawerSheet,
  tags: ["autodocs"],
  args: { open: true },
} satisfies Meta<typeof DrawerSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <DrawerSheet {...args}>
      <DrawerSheetTrigger asChild>
        <Button variant="outline">Open drawer</Button>
      </DrawerSheetTrigger>
      <DrawerSheetContent className="p-6">
        <DrawerSheetHeader>
          <DrawerSheetTitle>Edit profile</DrawerSheetTitle>
          <DrawerSheetDescription>
            Make changes to your profile here. Click save when you're done.
          </DrawerSheetDescription>
        </DrawerSheetHeader>
        <div className="mt-6 flex justify-end gap-2">
          <DrawerSheetClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DrawerSheetClose>
          <Button>Save changes</Button>
        </div>
      </DrawerSheetContent>
    </DrawerSheet>
  ),
};

export const WithCloseButton: Story = {
  render: (args) => (
    <DrawerSheet {...args}>
      <DrawerSheetTrigger asChild>
        <Button variant="outline">Open details</Button>
      </DrawerSheetTrigger>
      <DrawerSheetContent className="p-6" showCloseButton>
        <DrawerSheetHeader>
          <DrawerSheetTitle>Session details</DrawerSheetTitle>
          <DrawerSheetDescription>
            A corner close button is shown in the top-right of the panel.
          </DrawerSheetDescription>
        </DrawerSheetHeader>
      </DrawerSheetContent>
    </DrawerSheet>
  ),
};

export const DescriptionOnly: Story = {
  render: (args) => (
    <DrawerSheet {...args}>
      <DrawerSheetTrigger asChild>
        <Button variant="outline">Show notice</Button>
      </DrawerSheetTrigger>
      <DrawerSheetContent className="p-6">
        <DrawerSheetHeader>
          <DrawerSheetTitle>Heads up</DrawerSheetTitle>
          <DrawerSheetDescription>
            This action can't be undone. Review the details before continuing.
          </DrawerSheetDescription>
        </DrawerSheetHeader>
      </DrawerSheetContent>
    </DrawerSheet>
  ),
};

export const Destructive: Story = {
  render: (args) => (
    <DrawerSheet {...args}>
      <DrawerSheetTrigger asChild>
        <Button variant="destructive">Delete account</Button>
      </DrawerSheetTrigger>
      <DrawerSheetContent className="p-6">
        <DrawerSheetHeader>
          <DrawerSheetTitle>Delete account</DrawerSheetTitle>
          <DrawerSheetDescription>
            This permanently removes your account and all associated data.
          </DrawerSheetDescription>
        </DrawerSheetHeader>
        <div className="mt-6 flex justify-end gap-2">
          <DrawerSheetClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DrawerSheetClose>
          <Button variant="destructive">Delete</Button>
        </div>
      </DrawerSheetContent>
    </DrawerSheet>
  ),
};
