import type { ComponentPropsWithRef } from 'react';

import { Coins } from 'lucide-react';

import { Badge, type BadgeProps } from './Badge';

export type TokensBadgeProps = ComponentPropsWithRef<'span'> & {
  tokensCount: number;
  size?: BadgeProps['size'];
};

export const TokensBadge = ({ tokensCount, size, ...rest }: TokensBadgeProps) => {
  return (
    <Badge
      iconStart={<Coins className="size-2.5" />}
      theme="gray"
      size={size}
      {...rest}
      label={tokensCount}
    />
  );
};
