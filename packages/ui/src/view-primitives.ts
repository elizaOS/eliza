/** Browser-only primitives for embedded domain views, without the app barrel. */

export { useAgentElement } from "./agent-surface/useAgentElement.js";
export { isApiError } from "./api/api-error.js";
export { PagePanel } from "./components/composites/page-panel/index.js";
export { Button, type ButtonProps } from "./components/ui/button.js";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";
export { SegmentedControl } from "./components/ui/segmented-control.js";
export { CompactCardSkeleton } from "./components/ui/skeleton-layouts.js";
export { Spinner } from "./components/ui/spinner.js";
