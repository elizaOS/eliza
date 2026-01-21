import { cn } from "@polyagent/shared";
import type React from "react";

/**
 * Table component for displaying tabular data.
 *
 * Wraps table element with overflow handling and responsive styling.
 *
 * @param props - Table component props
 * @returns Table element wrapped in scrollable container
 *
 * @example
 * ```tsx
 * <Table>
 *   <TableHeader>...</TableHeader>
 *   <TableBody>...</TableBody>
 * </Table>
 * ```
 */
export const Table = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"table">) => (
  <div className="relative w-full overflow-auto">
    <table
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    >
      {children}
    </table>
  </div>
);

/**
 * Table header component.
 *
 * Container for table header row with border styling.
 *
 * @param props - TableHeader component props
 * @returns Table header element
 */
export const TableHeader = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"thead">) => (
  <thead className={cn("[&_tr]:border-b", className)} {...props}>
    {children}
  </thead>
);

/**
 * Table body component.
 *
 * Container for table body rows with border styling.
 *
 * @param props - TableBody component props
 * @returns Table body element
 */
export const TableBody = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"tbody">) => (
  <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props}>
    {children}
  </tbody>
);

/**
 * Table footer component.
 *
 * Container for table footer with muted background and border styling.
 *
 * @param props - TableFooter component props
 * @returns Table footer element
 */
export const TableFooter = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"tfoot">) => (
  <tfoot
    className={cn(
      "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
      className,
    )}
    {...props}
  >
    {children}
  </tfoot>
);

/**
 * Table row component.
 *
 * Table row with hover effects and selected state styling.
 *
 * @param props - TableRow component props
 * @returns Table row element
 */
export const TableRow = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"tr">) => (
  <tr
    className={cn(
      "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className,
    )}
    {...props}
  >
    {children}
  </tr>
);

/**
 * Table header cell component.
 *
 * Header cell with padding, alignment, and muted text styling.
 *
 * @param props - TableHead component props
 * @returns Table header cell element
 */
export const TableHead = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"th">) => (
  <th
    className={cn(
      "h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  >
    {children}
  </th>
);

/**
 * Table cell component.
 *
 * Table data cell with padding and alignment styling.
 *
 * @param props - TableCell component props
 * @returns Table cell element
 */
export const TableCell = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"td">) => (
  <td
    className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  >
    {children}
  </td>
);

/**
 * Table caption component.
 *
 * Table caption with top margin and muted text styling.
 *
 * @param props - TableCaption component props
 * @returns Table caption element
 */
export const TableCaption = ({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"caption">) => (
  <caption
    className={cn("mt-4 text-muted-foreground text-sm", className)}
    {...props}
  >
    {children}
  </caption>
);
