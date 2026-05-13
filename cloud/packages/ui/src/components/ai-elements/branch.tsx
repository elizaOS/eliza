/**
 * Branch component for displaying multiple conversation branches.
 * Supports navigation between branches with previous/next controls.
 *
 * @param props - Branch configuration
 * @param props.defaultBranch - Default branch index to display
 * @param props.onBranchChange - Callback when branch changes
 */

"use client";

import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRenderGuard } from "../../runtime/render-telemetry";
import { cn } from "../../lib/utils";
import { Button } from "../button";

type BranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  setTotalBranches: (totalBranches: number) => void;
};

const BranchContext = createContext<BranchContextType | null>(null);

const useBranch = () => {
  const context = useContext(BranchContext);

  if (!context) {
    throw new Error("Branch components must be used within Branch");
  }

  return context;
};

export type BranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const Branch = ({ defaultBranch = 0, onBranchChange, className, ...props }: BranchProps) => {
  useRenderGuard("Branch");
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [totalBranches, setTotalBranches] = useState(0);

  useEffect(() => {
    if (totalBranches > 0 && currentBranch >= totalBranches) {
      const nextBranch = totalBranches - 1;
      setCurrentBranch(nextBranch);
      onBranchChange?.(nextBranch);
    }
  }, [currentBranch, onBranchChange, totalBranches]);

  const goToPrevious = useCallback(() => {
    setCurrentBranch((prev) => {
      if (totalBranches <= 1) return prev;
      const newBranch = prev > 0 ? prev - 1 : totalBranches - 1;
      onBranchChange?.(newBranch);
      return newBranch;
    });
  }, [onBranchChange, totalBranches]);

  const goToNext = useCallback(() => {
    setCurrentBranch((prev) => {
      if (totalBranches <= 1) return prev;
      const newBranch = prev < totalBranches - 1 ? prev + 1 : 0;
      onBranchChange?.(newBranch);
      return newBranch;
    });
  }, [onBranchChange, totalBranches]);

  const contextValue = useMemo<BranchContextType>(
    () => ({
      currentBranch,
      totalBranches,
      goToPrevious,
      goToNext,
      setTotalBranches,
    }),
    [currentBranch, totalBranches, goToPrevious, goToNext],
  );

  return (
    <BranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </BranchContext.Provider>
  );
};

export type BranchMessagesProps = HTMLAttributes<HTMLDivElement>;

export const BranchMessages = ({ children, ...props }: BranchMessagesProps) => {
  const { currentBranch, setTotalBranches } = useBranch();
  const childrenArray = useMemo(
    () => Children.toArray(children) as ReactNode[],
    [children],
  );

  useEffect(() => {
    setTotalBranches(childrenArray.length);
    return () => setTotalBranches(0);
  }, [childrenArray.length, setTotalBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={isValidElement(branch) && branch.key != null ? branch.key : index}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type BranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const BranchSelector = ({ className, from, ...props }: BranchSelectorProps) => {
  const { totalBranches } = useBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 self-end px-10",
        from === "assistant" ? "justify-start" : "justify-end",
        className,
      )}
      {...props}
    />
  );
};

export type BranchPreviousProps = ComponentProps<typeof Button>;

export const BranchPrevious = ({ className, children, ...props }: BranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useBranch();

  return (
    <Button
      aria-label="Previous branch"
      className={cn(
        "size-7 shrink-0 rounded-full text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type BranchNextProps = ComponentProps<typeof Button>;

export const BranchNext = ({ className, children, ...props }: BranchNextProps) => {
  const { goToNext, totalBranches } = useBranch();

  return (
    <Button
      aria-label="Next branch"
      className={cn(
        "size-7 shrink-0 rounded-full text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type BranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const BranchPage = ({ className, ...props }: BranchPageProps) => {
  const { currentBranch, totalBranches } = useBranch();

  return (
    <span
      className={cn("font-medium text-muted-foreground text-xs tabular-nums", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </span>
  );
};
