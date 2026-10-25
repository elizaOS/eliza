/** Storybook fixture exercising the Carousel primitive (slides + prev/next controls); also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./carousel";

const slides = ["One", "Two", "Three", "Four", "Five"];

const meta = {
  title: "Primitives/Carousel",
  component: Carousel,
  tags: ["autodocs"],
  argTypes: {
    orientation: { control: "select", options: ["horizontal", "vertical"] },
  },
  args: { orientation: "horizontal" },
  render: (args) => (
    <Carousel {...args} className="mx-12 w-64">
      <CarouselContent>
        {slides.map((label) => (
          <CarouselItem key={label}>
            <div className="flex aspect-square items-center justify-center rounded-md border text-2xl font-semibold">
              {label}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
} satisfies Meta<typeof Carousel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Vertical: Story = {
  args: { orientation: "vertical" },
  render: (args) => (
    <Carousel {...args} className="my-12 w-64">
      <CarouselContent className="h-64">
        {slides.map((label) => (
          <CarouselItem key={label} className="basis-1/2">
            <div className="flex h-full items-center justify-center rounded-md border text-2xl font-semibold">
              {label}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};

export const MultipleVisible: Story = {
  render: (args) => (
    <Carousel {...args} opts={{ align: "start" }} className="mx-12 w-72">
      <CarouselContent>
        {slides.map((label) => (
          <CarouselItem key={label} className="basis-1/3">
            <div className="flex aspect-square items-center justify-center rounded-md border text-2xl font-semibold">
              {label}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};

export const Looping: Story = {
  render: (args) => (
    <Carousel {...args} opts={{ loop: true }} className="mx-12 w-64">
      <CarouselContent>
        {slides.map((label) => (
          <CarouselItem key={label}>
            <div className="flex aspect-square items-center justify-center rounded-md border text-2xl font-semibold">
              {label}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious />
      <CarouselNext />
    </Carousel>
  ),
};
