/**
 * Table primitives — `Table` wrapper plus header/body/footer/row/head/cell parts
 * with shared styling. Derived from shadcn/ui `table`
 * (https://ui.shadcn.com/docs/components/table).
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  density?: "default" | "compact" | "dense";
  layout?: "auto" | "fixed";
}

const TableFrame = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "overflow-auto rounded-sm border border-border/40 bg-card/95",
      className,
    )}
    {...props}
  />
));
TableFrame.displayName = "TableFrame";

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, density = "default", layout = "auto", ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table
        ref={ref}
        className={cn(
          "w-full caption-bottom",
          density === "default" && "text-sm",
          density === "compact" && "text-xs",
          density === "dense" && "text-2xs",
          layout === "fixed" && "table-fixed",
          className,
        )}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const tableHeaderVariants = cva("[&_tr]:border-b [&_tr]:border-border", {
  variants: {
    variant: {
      default: "",
      sticky: "sticky top-0 z-10 border-b border-border/40 bg-bg/95",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface TableHeaderProps
  extends React.HTMLAttributes<HTMLTableSectionElement>,
    VariantProps<typeof tableHeaderVariants> {}

const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, variant, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(tableHeaderVariants({ variant }), className)}
      {...props}
    />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t border-border bg-bg-accent/40 font-medium [&>tr]:last:border-b-0",
      className,
    )}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const tableRowVariants = cva(
  "border-b border-border/80 transition-colors hover:bg-bg-hover data-[state=selected]:bg-bg-accent",
  {
    variants: {
      variant: {
        default: "",
        topDivider: "border-t border-border/30",
        subtle: "border-b border-border/20 hover:bg-bg-hover",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface TableRowProps
  extends React.HTMLAttributes<HTMLTableRowElement>,
    VariantProps<typeof tableRowVariants> {}

const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, variant, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(tableRowVariants({ variant }), className)}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const tableHeadVariants = cva("", {
  variants: {
    divider: {
      none: "",
      subtle: "border-r border-border/40",
    },
    interactive: {
      false: "",
      true: "cursor-pointer bg-transparent transition-colors hover:bg-bg-hover",
    },
  },
  defaultVariants: { divider: "none", interactive: false },
});

export interface TableHeadProps
  extends React.ThHTMLAttributes<HTMLTableCellElement>,
    VariantProps<typeof tableHeadVariants> {}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, divider, interactive, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-10 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-[0.24em] text-muted [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        tableHeadVariants({ divider, interactive }),
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const tableCellVariants = cva("", {
  variants: {
    variant: {
      default: "",
      divided: "border-r border-border/20",
      rowNumber: "border-r border-border/30 bg-bg/20",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface TableCellProps
  extends React.TdHTMLAttributes<HTMLTableCellElement>,
    VariantProps<typeof tableCellVariants> {}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, variant, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "p-3 align-middle text-txt [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        tableCellVariants({ variant }),
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
};
