import type { ComponentPropsWithRef } from 'react';

import { Badge, type BadgeProps } from './Badge';

export type PriceBadgeProps = ComponentPropsWithRef<'span'> & {
  cost: number;
  size?: BadgeProps['size'];
};

export const PriceBadge = ({ cost, size, ...rest }: PriceBadgeProps) => {
  return <Badge theme="gray" size={size} {...rest} label={`$ ${cost}`} />;
};
