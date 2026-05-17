/**
 * Carousel component using Embla Carousel for slide-based content display.
 * Supports horizontal and vertical orientations with navigation controls.
 */
import useEmblaCarousel, {
  type UseEmblaCarouselType,
} from "embla-carousel-react";
import * as React from "react";
import { Button } from "./button";

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];
type CarouselProps = {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: "horizontal" | "vertical";
  setApi?: (api: CarouselApi) => void;
};
declare function Carousel({
  orientation,
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> &
  CarouselProps): import("react/jsx-runtime").JSX.Element;
declare function CarouselContent({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare function CarouselItem({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare function CarouselPrevious({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<
  typeof Button
>): import("react/jsx-runtime").JSX.Element;
declare function CarouselNext({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<
  typeof Button
>): import("react/jsx-runtime").JSX.Element;

export {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
};
//# sourceMappingURL=carousel.d.ts.map
