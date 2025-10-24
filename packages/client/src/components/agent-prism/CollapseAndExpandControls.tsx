import type { ComponentPropsWithRef } from 'react';

import { ChevronsUpDown, ChevronsDownUp } from 'lucide-react';

import { IconButton } from './IconButton.tsx';

export type SpanCardExpandAllButtonProps = ComponentPropsWithRef<'button'> & {
  onExpandAll: () => void;
};

export type SpanCardCollapseAllButtonProps = ComponentPropsWithRef<'button'> & {
  onCollapseAll: () => void;
};

export const ExpandAllButton = ({ onExpandAll, ...rest }: SpanCardExpandAllButtonProps) => {
  return (
    <IconButton size="7" onClick={onExpandAll} aria-label="Expand all" icon={ChevronsUpDown} {...rest} />
  );
};

export const CollapseAllButton = ({ onCollapseAll, ...rest }: SpanCardCollapseAllButtonProps) => {
  return (
    <IconButton size="7" onClick={onCollapseAll} aria-label="Collapse all" icon={ChevronsDownUp} {...rest} />
  );
};
